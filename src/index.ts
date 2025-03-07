interface Env {
    MYBROWSER: any;
    BROWSER_KV_MM: KVNamespace;
    AI: Ai;
    DB: D1Database;
    DB_MEN: D1Database;
}

interface TeamStats {
    [key: string]: string;
}

interface NcaaD1Response {
    data: {
        conference: string;
        standings: TeamStats[];
    }[];
}

interface AiTextGenerationOutput {
    response: string;
}

interface CachedData {
    timestamp: number;
    response: string;
    teams: string[];
    stats: any[];
    gender: 'men' | 'women';
}

export default {
    async fetch(request: Request, env: Env) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept",
        };

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        // Parse the URL
        const url = new URL(request.url);
        console.log(`Received ${request.method} request to ${url.pathname}`);

        // Route handling
        if (request.method === "GET") {
            if (url.pathname === "/" || url.pathname === "") {
                // Return the HTML form for the root path
                return new Response(getHtmlForm(), {
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "text/html",
                    },
                });
            }

            if (url.pathname === "/stats") {
                // Return the stats page
                return new Response(getStatsPage(), {
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "text/html",
                    },
                });
            }

            if (url.pathname === "/api/stats") {
                try {
                    const gender = url.searchParams.get("gender") || "women"; // Default to women's data
                    console.log(`Fetching stats for gender: ${gender}`);
                    const db = gender === "men" ? env.DB_MEN : env.DB; // Use DB_MEN for men's data, DB for women's data
                    console.log(`Using database: ${gender === "men" ? "DB_MEN" : "DB"}`);
                    const statsData = await db
                        .prepare(`
                            SELECT 
                                s.*,
                                c.name as conference_name
                            FROM standings s
                            JOIN conferences c ON s.conference_id = c.id
                            ORDER BY c.name, s.overall_pct DESC
                        `)
                        .all();

                    return new Response(JSON.stringify(statsData.results), {
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    });
                } catch (error) {
                    console.error('Database error:', error);
                    return new Response(JSON.stringify({ error: 'Failed to fetch stats' }), {
                        status: 500,
                        headers: corsHeaders
                    });
                }
            }

            if (url.pathname === "/init-db-men") {
                try {
                    await initializeMenDatabase(env.DB_MEN);
                    return new Response(JSON.stringify({ message: "Men's database initialized successfully" }), {
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    });
                } catch (error) {
                    console.error('Error initializing men\'s database:', error);
                    return new Response(JSON.stringify({ error: 'Failed to initialize men\'s database' }), {
                        status: 500,
                        headers: corsHeaders
                    });
                }
            }
        }

        if (request.method === "POST" && url.pathname === "/analyze") {
            try {
                const requestData = await request.json();
                const { teams, gender = 'women' } = requestData as { teams: string[], gender?: 'men' | 'women' };

                if (!Array.isArray(teams) || teams.length === 0) {
                    return new Response(JSON.stringify({ error: "Please provide at least one team name" }), {
                        status: 400,
                        headers: corsHeaders
                    });
                }

                const normalizedTeams = teams.map(team => team.toLowerCase().trim());
                const cacheKey = `analysis_${gender}_${normalizedTeams.sort().join('_')}`;

                // Try cache first
                const cachedAnalysis = await env.BROWSER_KV_MM.get(cacheKey, 'json') as CachedData | null;
                if (cachedAnalysis && (Date.now() - cachedAnalysis.timestamp) < 3600000) {
                    console.log('Returning cached analysis');
                    return new Response(JSON.stringify(cachedAnalysis), {
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    });
                }

                // Get stats data
                const db = gender === 'men' ? env.DB_MEN : env.DB;
                const statsData = await db
                    .prepare(`
                        SELECT 
                            s.*,
                            c.name as conference_name
                        FROM standings s
                        JOIN conferences c ON s.conference_id = c.id
                        WHERE LOWER(s.school) IN (${normalizedTeams.map(() => '?').join(',')})
                    `)
                    .bind(...normalizedTeams)
                    .all();

                // Function to attempt AI analysis with timeout and single-team processing
                async function getAiAnalysis(timeout = 30000) {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeout);

                    try {
                        // Process one team at a time
                        const analyses = await Promise.all(statsData.results.map(async (team) => {
                            try {
                                const teamResponse = await env.AI.run(
                                    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                                    { 
                                        max_tokens: 2048,
                                        messages: [
                                            { role: "system", content: "You are a basketball analyst. Provide a very brief analysis." },
                                            { 
                                                role: "user", 
                                                content: `Quick analysis of ${team.school} (${gender}'s):\nConference: ${team.conference_name}\nOverall: ${team.overall_wins}-${team.overall_losses}\nConference: ${team.conference_wins}-${team.conference_losses}\n\nProvide a 2-3 sentence analysis.` 
                                            }
                                        ]
                                    }
                                ) as AiTextGenerationOutput;
                                return `${team.school}: ${teamResponse.response}`;
                            } catch (error) {
                                console.error(`Error analyzing ${team.school}:`, error);
                                return `${team.school}: Stats only - Overall: ${team.overall_wins}-${team.overall_losses}, Conference: ${team.conference_wins}-${team.conference_losses}`;
                            }
                        }));

                        // Combine individual analyses
                        return {
                            response: analyses.join('\n\n')
                        };
                    } finally {
                        clearTimeout(timeoutId);
                    }
                }

                try {
                    const aiResponse = await getAiAnalysis();
                    const response: CachedData = {
                        timestamp: Date.now(),
                        response: aiResponse.response,
                        teams: teams,
                        stats: statsData.results,
                        gender
                    };

                    // Cache successful response
                    await env.BROWSER_KV_MM.put(cacheKey, JSON.stringify(response), { expirationTtl: 3600 });

                    return new Response(JSON.stringify(response), {
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    });
                } catch (aiError) {
                    // If AI fails, return just the stats
                    console.error('AI Analysis failed:', aiError);
                    const fallbackResponse = {
                        response: "AI analysis temporarily unavailable. Please try again later.",
                        teams: teams,
                        stats: statsData.results
                    };

                    return new Response(JSON.stringify(fallbackResponse), {
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    });
                }
            } catch (error) {
                console.error('Error:', error);
                return new Response(JSON.stringify({ 
                    error: "Service temporarily unavailable. Please try again.",
                    details: String(error)
                }), {
                    status: 503,
                    headers: corsHeaders
                });
            }
        }

        // If no route matches, return 404
        return new Response("Not Found", {
            status: 404,
            headers: corsHeaders
        });
    }
};

// Function to initialize the men's database
async function initializeMenDatabase(db: D1Database) {
    try {
        console.log("Fetching data from NCAA API...");
        const apiUrl = "https://ncaa-api.fly.dev";
        const response = await fetch(`${apiUrl}/standings/basketball-men/d1`);

        if (!response.ok) {
            throw new Error(`API responded with status: ${response.status}`);
        }

        console.log("Data fetched successfully. Parsing JSON...");
        const data = await response.json() as NcaaD1Response;
        console.log("API Response:", JSON.stringify(data, null, 2));

        console.log("Clearing existing data from DB_MEN...");
        await db.prepare("DELETE FROM standings").run();
        await db.prepare("DELETE FROM conferences").run();
        console.log("Existing data cleared from DB_MEN.");

        console.log("Inserting new data into DB_MEN...");
        for (const conference of data.data) {
            const { conference: conferenceName, standings } = conference;

            if (!conferenceName || !standings) {
                console.warn("Skipping invalid conference:", conference);
                continue;
            }

            console.log(`Inserting conference: ${conferenceName}`);
            const conferenceResult = await db.prepare(`
                INSERT INTO conferences (name) VALUES (?)
            `).bind(conferenceName).run();

            const conferenceId = conferenceResult.meta.last_row_id;
            console.log(`Conference inserted with ID: ${conferenceId}`);

            for (const team of standings) {
                // Validate required fields
                if (!team.School || team["Overall W"] === undefined || team["Overall L"] === undefined) {
                    console.warn("Skipping invalid team:", team);
                    continue;
                }

                // Map API fields to database fields
                const overallWins = parseInt(team["Overall W"], 10);
                const overallLosses = parseInt(team["Overall L"], 10);
                const overallPct = parseFloat(team["Overall PCT"]) || 0;
                const conferenceWins = parseInt(team["Conference W"], 10) || 0;
                const conferenceLosses = parseInt(team["Conference L"], 10) || 0;
                const conferencePct = parseFloat(team["Conference PCT"]) || 0;

                console.log(`Inserting team: ${team.School} into conference: ${conferenceName}`);
                await db.prepare(`
                    INSERT INTO standings (
                        conference_id, school, overall_wins, overall_losses, overall_pct,
                        conference_wins, conference_losses, conference_pct
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    conferenceId,
                    team.School,
                    overallWins,
                    overallLosses,
                    overallPct,
                    conferenceWins,
                    conferenceLosses,
                    conferencePct
                ).run();
                console.log(`Team inserted: ${team.School}`);
            }
        }

        console.log("Data insertion into DB_MEN completed successfully.");
    } catch (error) {
        console.error("Error initializing men's database:", error);
        throw error;
    }
}

// Function to return the HTML form
function getHtmlForm() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NCAA Basketball Analysis</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.js"></script>
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');

    * {
        font-family: 'Poppins', sans-serif;
    }

    body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(135deg, #1a472a, #2d5a40);
        color: #2d3748; /* Darker text for better readability */
        display: flex;
        flex-direction: column;
        padding: 0;
    }

    .bouncing-ball {
        position: fixed;
        font-size: 50px;
        user-select: none;
        z-index: -1;
        bottom: 20px;
        animation: bounce 2s infinite, moveLeftRight 15s infinite;
    }

    .bouncing-ball:nth-child(1) {
        left: 5%;
    }

    .bouncing-ball:nth-child(2) {
        right: 5%;
        animation-delay: 1s;
    }

    @keyframes bounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-20px); }
    }

    @keyframes moveLeftRight {
        0% { left: 5%; }
        50% { left: 20%; }
        100% { left: 5%; }
    }

    @keyframes moveRightLeft {
        0% { right: 5%; }
        50% { right: 20%; }
        100% { right: 5%; }
    }

    .content-wrapper {
        text-align: center;
        margin: 0 auto;
        max-width: 800px;
        padding: 2rem;
    }

    .card {
        background: rgba(255, 255, 255, 0.95); /* Light background for contrast */
        backdrop-filter: blur(10px);
        border-radius: 1.5rem;
        box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
        padding: 2.5rem;
        border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .card h1 {
        font-size: 2.75rem;
        font-weight: 700;
        background: linear-gradient(45deg, #ff7e5f, #feb47b);
        -webkit-background-clip: text;
        color: transparent;
        margin-bottom: 1.5rem;
    }

    .card p {
        color: #4a5568; /* Dark gray for better readability */
        font-size: 1.1rem;
        margin-bottom: 2rem;
    }

    .card a {
        color: #3182ce !important; /* Blue for links */
        text-decoration: underline;
    }

    .card a:hover {
        color: #feb47b !important; /* Orange on hover */
    }

    .card a:active {
        color: #ff69b4 !important; /* Pink when clicked */
    }

    .card button {
        transition: all 0.3s ease;
        font-weight: 600;
        letter-spacing: 0.5px;
    }

    .card button:hover {
        transform: translateY(-3px);
        box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
    }

    .card textarea {
        min-width: 300px;
        width: 100%;
        background: rgba(255, 255, 255, 0.5);
        backdrop-filter: blur(4px);
        border: 2px solid #fb923c;
        border-radius: 0.75rem;
        transition: border-color 0.3s ease;
        font-size: 1rem;
        padding: 1rem;
        color: #2d3748;
        text-align: center;
    }

    .card textarea::placeholder {
        color: #6b7280;
        opacity: 1;
    }

    .card textarea:focus {
        outline: none;
        border-color: #f97316;
        box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.2);
    }

    .loading-spinner {
        border-top-color: #feb47b;
        border-width: 3px;
    }

    .result-box {
        background: rgba(255, 255, 255, 0.9);
        border-radius: 0.75rem;
        padding: 1.5rem;
        margin-top: 1.5rem;
        border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .result-box p {
        color: #4a5568; /* Dark gray for better readability */
        font-size: 1.1rem;
        line-height: 1.6;
    }

    footer {
        background: rgba(178, 34, 34, 0.3);
        color: rgba(255, 255, 255, 0.9);
        padding: 1.5rem;
        text-align: center;
        margin-top: auto;
        font-size: 0.95rem;
    }

    footer a {
        color: white;
        text-decoration: underline;
        font-weight: 600;
    }

    footer a:hover {
        color: #feb47b; /* Orange on hover */
    }

    footer a:active {
        color: #ff69b4; /* Pink when clicked */
    }

    .form-radio {
        accent-color: #feb47b;
    }

    .form-radio:checked {
        background-color: #feb47b;
    }

    .form-radio:focus {
        box-shadow: 0 0 0 3px rgba(254, 180, 123, 0.2);
    }
</style>
</head>
<body class="bg-gradient-to-br from-orange-100 to-orange-200 min-h-screen p-8">
    <div class="bouncing-ball">🏀</div>
    <div class="bouncing-ball">🏀</div>
    
    <div class="content-wrapper">
        <div class="card">
            <div class="bg-white/90 backdrop-blur-sm rounded-xl shadow-2xl p-8 relative">
                <h1 class="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-orange-600 to-orange-400 bg-clip-text text-transparent">
                    NCAA Basketball Analysis
                </h1>
                <p class="text-center text-gray-700 mb-8">
                    Data from <a href="https://www.ncaa.com/standings/basketball-{gender}/d1" style="color: white; text-decoration: underline;" target="_blank">ncaa.com/standings/basketball-women/d1</a>
                </p>
            </div>
            <div class="flex justify-center space-x-4 mb-8">
                <button 
                    onclick="window.location.href='/'"
                    class="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors">
                    Analysis
                </button>
                <button 
                    onclick="window.location.href='/stats'"
                    class="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors">
                    Statistics
                </button>
            </div>

            <form id="teamForm" class="space-y-6">
                <div class="mb-6">
                    <label class="block text-lg font-medium text-gray-700 mb-3 text-center">Select Division</label>
                    <div class="flex justify-center space-x-4">
                        <label class="inline-flex items-center">
                            <input type="radio" name="gender" value="women" checked class="form-radio text-orange-500">
                            <span class="ml-2 text-gray-700">Women's</span>
                        </label>
                        <label class="inline-flex items-center">
                            <input type="radio" name="gender" value="men" class="form-radio text-orange-500">
                            <span class="ml-2 text-gray-700">Men's</span>
                        </label>
                    </div>
                </div>
                <div>
                    <label for="teams" class="block text-lg font-medium text-gray-700 mb-3 text-center">
                        Enter Up to 2 Team Names (One Per Line)
                    </label>
                    <textarea 
                        id="teams" 
                        name="teams" 
                        rows="2" 
                        placeholder="Example: South Carolina 
                        Stanford"
                        class="min-w-[300px] w-full bg-white/50 backdrop-blur-sm border-2 border-orange-400 rounded-lg p-4 text-center text-gray-700 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                    ></textarea>
                </div>
                <div class="flex flex-col items-center space-y-8">
                    <button 
                        type="submit" 
                        class="w-64 bg-gradient-to-r from-orange-600 to-orange-400 text-white py-3 px-6 rounded-lg text-lg font-semibold hover:from-orange-700 hover:to-orange-500 transform hover:scale-105 transition-all focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2">
                        Analyze Teams 🏀
                    </button>
                </div>
            </form>
            
            <div id="loadingIndicator" class="hidden mt-6 text-center">
                <div class="animate-spin rounded-full h-12 w-12 border-4 border-orange-500 border-t-transparent mx-auto"></div>
                <div id="loadingText" class="mt-3 text-lg text-orange-600 animate-pulse" style="display: none;">
                    Analyzing teams... 🏀
                </div>
            </div>
            
            <div id="result" class="mt-8 p-6 bg-white/70 backdrop-blur-sm rounded-lg hidden">
                <p id="analysisText" class="text-gray-700 whitespace-pre-line text-lg leading-relaxed text-center"></p>
            </div>
        </div>
    </div>

    <script>
        document.getElementById('teamForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const teams = document.getElementById('teams').value
                .split('\\n')
                .map(team => team.trim())
                .filter(team => team.length > 0);
            
            const gender = document.querySelector('input[name="gender"]:checked').value;
            
            if (teams.length === 0) {
                alert('Please enter at least one team name');
                return;
            }

            const loadingIndicator = document.getElementById('loadingIndicator');
            const loadingText = document.getElementById('loadingText');
            const result = document.getElementById('result');
            
            loadingIndicator.classList.remove('hidden');
            loadingText.style.display = 'block';
            result.classList.add('hidden');

            try {
                const response = await fetch('/analyze', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({ teams, gender })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'An error occurred');
                }

                const data = await response.json();
                document.getElementById('analysisText').textContent = data.response;
                document.getElementById('result').classList.remove('hidden');
            } catch (error) {
                console.error('Error:', error);
                alert('Error getting analysis: ' + JSON.stringify(error));
            } finally {
                loadingIndicator.classList.add('hidden');
                loadingText.style.display = 'none';
            }
        });
    </script>
    <footer>
        Made w/ ❤️ in sf 🌁 using <a href="https://developers.cloudflare.com/workers-ai/" 
            style="color: white; text-decoration: underline;"
            target="_blank">
            Cloudflare Workers AI, D1
        </a> -> 
        <a href="https://github.com/elizabethsiegle/marchmadness-prediction-analysis-worker" 
            style="color: white; text-decoration: underline;"
            target="_blank">
            GitHub
        </a>
    </footer>
</body>
</html>
    `;
}

function getStatsPage() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NCAA Basketball Statistics</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');

        * {
            font-family: 'Poppins', sans-serif;
        }

        body {
            margin: 0;
            min-height: 100vh;
            background: linear-gradient(135deg, #1a472a, #2d5a40);
            color: #2d3748; /* Darker text for better readability */
            display: flex;
            flex-direction: column;
            padding: 0;
        }

        .bouncing-ball {
            position: fixed;
            font-size: 50px;
            user-select: none;
            z-index: -1;
            bottom: 20px;
            animation: bounce 2s infinite, moveLeftRight 15s infinite;
        }

        .bouncing-ball:nth-child(1) {
            left: 5%;
        }

        .bouncing-ball:nth-child(2) {
            right: 5%;
            animation-delay: 1s;
        }

        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
        }

        @keyframes moveLeftRight {
            0% { left: 5%; }
            50% { left: 20%; }
            100% { left: 5%; }
        }

        @keyframes moveRightLeft {
            0% { right: 5%; }
            50% { right: 20%; }
            100% { right: 5%; }
        }

        .content-wrapper {
            text-align: center;
            margin: 0 auto;
            max-width: 800px;
            padding: 2rem;
        }

        .card {
            background: rgba(255, 255, 255, 0.95); /* Light background for contrast */
            backdrop-filter: blur(10px);
            border-radius: 1.5rem;
            box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
            padding: 2.5rem;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .card h1 {
            font-size: 2.75rem;
            font-weight: 700;
            background: linear-gradient(45deg, #ff7e5f, #feb47b);
            -webkit-background-clip: text;
            color: transparent;
            margin-bottom: 1.5rem;
        }

        .card p {
            color: #4a5568; /* Dark gray for better readability */
            font-size: 1.1rem;
            margin-bottom: 2rem;
        }

        .card a {
            color: #3182ce; /* Blue for links */
            text-decoration: underline;
        }

        .card a:hover {
            color: #feb47b; /* Orange on hover */
        }

        .card a:active {
            color: #ff69b4; /* Pink when clicked */
        }

        .card button {
            transition: all 0.3s ease;
            font-weight: 600;
            letter-spacing: 0.5px;
        }

        .card button:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
        }

        .loading-spinner {
            border-top-color: #feb47b;
            border-width: 3px;
        }

        .result-box {
            background: rgba(255, 255, 255, 0.9);
            border-radius: 0.75rem;
            padding: 1.5rem;
            margin-top: 1.5rem;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .result-box p {
            color: #4a5568; /* Dark gray for better readability */
            font-size: 1.1rem;
            line-height: 1.6;
        }

        footer {
            background: rgba(178, 34, 34, 0.3);
            color: rgba(255, 255, 255, 0.9);
            padding: 1.5rem;
            text-align: center;
            margin-top: auto;
            font-size: 0.95rem;
        }

        footer a {
            color: white;
            text-decoration: underline;
            font-weight: 600;
        }

        footer a:hover {
            color: #feb47b; /* Orange on hover */
        }

        footer a:active {
            color: #ff69b4; /* Pink when clicked */
        }

        .form-radio {
            accent-color: #feb47b;
        }

        .form-radio:checked {
            background-color: #feb47b;
        }

        .form-radio:focus {
            box-shadow: 0 0 0 3px rgba(254, 180, 123, 0.2);
        }

        .chart-container {
            background: rgba(255, 255, 255, 0.9);
            border-radius: 1rem;
            padding: 1.5rem;
            margin: 1.5rem 0;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
    </style>
</head>
<body class="bg-gradient-to-br from-orange-100 to-orange-200 min-h-screen p-8">
    <div class="bouncing-ball">🏀</div>
    <div class="bouncing-ball">🏀</div>

    <div class="content-wrapper">
        <div class="card">
            <h1 class="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-orange-600 to-orange-400 bg-clip-text text-transparent">
                NCAA Basketball Statistics
            </h1>
            <p class="text-center text-gray-700 mb-8">
                Data from <a href="https://www.ncaa.com/standings/basketball-women/d1" class="underline" target="_blank">ncaa.com</a>
            </p>

            <div class="flex justify-center space-x-4 mb-8">
                <button 
                    onclick="window.location.href='/'" 
                    class="px-6 py-2 bg-gradient-to-r from-orange-400 to-orange-500 text-white rounded-lg hover:from-orange-500 hover:to-orange-600">
                    Analysis
                </button>
                <button 
                    onclick="window.location.href='/stats'" 
                    class="px-6 py-2 bg-gradient-to-r from-orange-400 to-orange-500 text-white rounded-lg hover:from-orange-500 hover:to-orange-600">
                    Statistics
                </button>
            </div>

            <div class="mb-8">
                <div class="flex justify-center space-x-4 mb-6">
                    <label class="inline-flex items-center">
                        <input type="radio" name="gender" value="women" checked class="form-radio text-orange-500">
                        <span class="ml-2 text-gray-700">Women's</span>
                    </label>
                    <label class="inline-flex items-center">
                        <input type="radio" name="gender" value="men" class="form-radio text-orange-500">
                        <span class="ml-2 text-gray-700">Men's</span>
                    </label>
                </div>

                <label for="conferenceSelect" class="block text-lg font-medium text-gray-700 mb-2 text-center">
                    Select Conference
                </label>
                <select id="conferenceSelect" 
                    class="block mx-auto w-64 p-2 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-orange-500 focus:border-orange-500">
                    <option value="">Select a conference...</option>
                </select>
            </div>

            <div id="chartContainer" class="chart-container">
                <canvas id="conferenceChart"></canvas>
            </div>
        </div>
    </div>

    <footer>
        Made with ❤️ in SF 🌁 using <a href="https://developers.cloudflare.com/workers-ai/" target="_blank">Cloudflare Workers AI, D1</a> →
        <a href="https://github.com/elizabethsiegle/marchmadness-prediction-analysis-worker" target="_blank">GitHub</a>
    </footer>

    <script>
        let currentChart = null;
        let currentData = null;

        async function fetchAndDisplayStats(gender) {
            try {
                const response = await fetch('/api/stats?gender=' + gender);
                if (!response.ok) {
                    throw new Error('Failed to fetch stats');
                }
                const data = await response.json();
                currentData = data;
                
                // Group by conference
                const conferenceData = data.reduce((acc, team) => {
                    if (!acc[team.conference_name]) {
                        acc[team.conference_name] = [];
                    }
                    acc[team.conference_name].push(team);
                    return acc;
                }, {});

                // Clear and repopulate dropdown
                const select = document.getElementById('conferenceSelect');
                select.innerHTML = '<option value="">Select a conference...</option>';
                
                Object.keys(conferenceData).sort().forEach(conference => {
                    const option = document.createElement('option');
                    option.value = conference;
                    option.textContent = conference;
                    select.appendChild(option);
                });

                // If there was a previously selected conference, try to reselect it
                const previousSelection = select.getAttribute('data-previous-selection');
                if (previousSelection && select.querySelector(\`option[value="\${previousSelection}"]\`)) {
                    select.value = previousSelection;
                    createConferenceChart(previousSelection, conferenceData[previousSelection]);
                }
            } catch (error) {
                console.error('Error:', error);
            }
        }

        // Add event listeners
        document.querySelectorAll('input[name="gender"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                fetchAndDisplayStats(e.target.value);
            });
        });

        document.getElementById('conferenceSelect').addEventListener('change', (e) => {
            const select = e.target;
            const selectedConference = select.value;
            select.setAttribute('data-previous-selection', selectedConference);
            
            if (selectedConference && currentData) {
                const conferenceData = currentData.reduce((acc, team) => {
                    if (!acc[team.conference_name]) {
                        acc[team.conference_name] = [];
                    }
                    acc[team.conference_name].push(team);
                    return acc;
                }, {});
                
                if (conferenceData[selectedConference]) {
                    createConferenceChart(selectedConference, conferenceData[selectedConference]);
                }
            } else {
                if (currentChart) {
                    currentChart.destroy();
                    currentChart = null;
                }
            }
        });

        // Initial load
        fetchAndDisplayStats('women');

        function createConferenceChart(conference, teams) {
            const canvas = document.getElementById('conferenceChart');
            const colors = {
                wins: 'rgba(16, 185, 129, 0.7)',    // Green
                losses: 'rgba(239, 68, 68, 0.7)',   // Red
                pct: 'rgba(245, 158, 11, 0.7)'      // Orange
            };

            // Sort teams by conference percentage
            const sortedTeams = [...teams].sort((a, b) => b.conference_pct - a.conference_pct);

            // Destroy existing chart if it exists
            if (currentChart) {
                currentChart.destroy();
            }

            // Create new chart
            currentChart = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: sortedTeams.map(team => team.school),
                    datasets: [
                        {
                            label: 'Conference Wins',
                            data: sortedTeams.map(team => team.conference_wins),
                            backgroundColor: colors.wins,
                            order: 2
                        },
                        {
                            label: 'Conference Losses',
                            data: sortedTeams.map(team => team.conference_losses),
                            backgroundColor: colors.losses,
                            order: 3
                        },
                        {
                            label: 'Win %',
                            data: sortedTeams.map(team => (team.conference_pct * 100).toFixed(1)),
                            type: 'line',
                            borderColor: colors.pct,
                            borderWidth: 2,
                            fill: false,
                            yAxisID: 'percentage',
                            order: 1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        title: {
                            display: true,
                            text: conference,
                            font: {
                                size: 16,
                                weight: 'bold'
                            },
                            color: '#EA580C' // orange-600
                        },
                        legend: {
                            position: 'top'
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    if (context.dataset.label === 'Win %') {
                                        return \`Win %: \${context.raw}%\`;
                                    }
                                    return \`\${context.dataset.label}: \${context.raw}\`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            ticks: {
                                maxRotation: 45,
                                minRotation: 45
                            }
                        },
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Games'
                            }
                        },
                        percentage: {
                            beginAtZero: true,
                            max: 100,
                            position: 'right',
                            title: {
                                display: true,
                                text: 'Win %'
                            }
                        }
                    }
                }
            });
        }
    </script>
</body>
</html>
    `;
}



  