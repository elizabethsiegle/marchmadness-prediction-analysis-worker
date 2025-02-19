interface Env {
	MYBROWSER: any;
	BROWSER_KV_MM: KVNamespace;
	AI: Ai;
	DB: D1Database;
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
	data: NcaaD1Response;
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
			const statsData = await env.DB
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
	  }
  
	  if (request.method === "POST" && url.pathname === "/analyze") {
		try {
		  const requestData = await request.json();
		  const { teams, gender = 'women' } = requestData as { teams: string[], gender?: 'men' | 'women' };
		  
		  if (!Array.isArray(teams) || teams.length === 0) {
			return new Response(JSON.stringify({ error: "Please provide at least one team name" }), { 
			  status: 400,
			  headers: {
				...corsHeaders,
				"Content-Type": "application/json"
			  }
			});
		  }
  
		  const normalizedTeams = teams.map(team => team.toLowerCase().trim());
  
		  // Check cache for base data with gender-specific key
		  let ncaaData: NcaaD1Response['data'];
		  const cacheKey = `ncaa_data_cache_${gender}`;
		  const cachedResponse = await env.BROWSER_KV_MM.get(cacheKey, 'json') as CachedData | null;
		  const now = Date.now();
  
		  if (cachedResponse && (now - cachedResponse.timestamp) < 3600000) {
			ncaaData = cachedResponse.data.data;
		  } else {
			const apiUrl = "https://ncaa-api.fly.dev";
			const response = await fetch(`${apiUrl}/standings/basketball-${gender}/d1`);
			
			if (!response.ok) {
			  throw new Error(`API responded with status: ${response.status}`);
			}
  
			const data = await response.json() as NcaaD1Response;
			ncaaData = data.data;
  
			await env.BROWSER_KV_MM.put(cacheKey, JSON.stringify({
			  timestamp: now,
			  data: data,
			  gender
			}));
		  }
  
		  const filteredData = ncaaData.map(conference => ({
			conference: conference.conference,
			standings: conference.standings.filter(team => 
			  normalizedTeams.includes(team.School?.toLowerCase().trim())
			)
		  })).filter(conference => conference.standings.length > 0);
  
		  const prompt = `Analyze the performance of the following teams in NCAA ${gender === 'women' ? "Women's" : "Men's"} Basketball: ${teams.join(', ')}
		  
		  Here is their current standing data:
			${JSON.stringify(filteredData, null, 2)}
			
			Please provide:
			1. Current performance analysis for each requested team
			2. Their position within their respective conferences
			3. Notable streaks or trends
			4. Comparative analysis between the requested teams if multiple teams are provided`;
  
		  const messages = [
			{ role: "system", content: "You are an esteemed basketball analyst focusing on NCAA Women's Basketball. Provide clear, succinct analysis with specific statistics and context." },
			{ role: "user", content: prompt },
		  ];
		  
		  const aiResponse = await env.AI.run(
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast", 
			{ max_tokens: 8196, messages }
		  ) as AiTextGenerationOutput;
  
		  return new Response(JSON.stringify({
			response: aiResponse.response,
			teams: teams,
			filteredData
		  }), {
			headers: {
			  ...corsHeaders,
			  "Content-Type": "application/json"
			}
		  });
  
		} catch (error) {
		  console.error('Error:', error);
		  return new Response(JSON.stringify({ error: error }), { 
			status: 500,
			headers: {
			  ...corsHeaders,
			  "Content-Type": "application/json"
			}
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
  
  // Function to return the HTML form
  function getHtmlForm() {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NCAA Women's Basketball Analysis</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&display=swap');
        
        * {
            font-family: 'Comic Neue', cursive;
        }
		body {
			margin: 0;
			font-family: system-ui;
			min-height: 100vh;
			background: linear-gradient(135deg, #1a472a, #2d5a40);
			color: white;
			display: flex;
			flex-direction: column;
			padding: 0;
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

        .bouncing-ball {
            position: fixed;
            font-size: 50px;
            user-select: none;
            z-index: -1;
            bottom: 20px;
        }
        .bouncing-ball:nth-child(1) { 
            left: 5%; 
            animation: bounce 1.5s infinite, moveLeftRight 15s infinite;
        }
        .bouncing-ball:nth-child(2) { 
            right: 5%; 
            animation: bounce 2s infinite, moveRightLeft 12s infinite;
        }
        .content-wrapper {
            text-align: center;
            margin: 0 auto;
            max-width: 800px;
        }
		footer {
			text-align: center;
			padding: 1rem;
			color: rgba(255, 255, 255, 0.8);
			font-size: 0.9rem;
			background-color: rgba(178, 34, 34, 0.3);
			width: 100%;
			margin-top: auto;
        }
    </style>
</head>
<body class="bg-gradient-to-br from-orange-100 to-orange-200 min-h-screen p-8">
    <div class="bouncing-ball">🏀</div>
    <div class="bouncing-ball">🏀</div>
    
    <div class="content-wrapper">
        <div class="bg-white/90 backdrop-blur-sm rounded-xl shadow-2xl p-8 relative">
            <h1 class="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-orange-600 to-orange-400 bg-clip-text text-transparent">
                NCAA Women's Basketball Analysis
            </h1>
			<p class="text-center text-gray-700 mb-8">
			Data from <a href="https://www.ncaa.com/standings/basketball-women/d1" style="color: white; text-decoration: underline;" target="_blank">ncaa.com/standings/basketball-women/d1</a>
			</p>
            
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
                        Enter Team Names (One Per Line)
                    </label>
                    <textarea 
                        id="teams" 
                        name="teams" 
                        rows="5" 
                        class="w-full p-4 border-2 border-orange-300 rounded-lg focus:ring-orange-500 focus:border-orange-500 bg-white/50 backdrop-blur-sm text-center"
                        placeholder="Example:
							South Carolina
							Stanford
							UConn"></textarea>
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
                alert('Error getting analysis: ' + error.message);
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
			Cloudflare Workers AI
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
    <title>NCAA Women's Basketball Data Visualizations</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&display=swap');
        
        * {
            font-family: 'Comic Neue', cursive;
        }
		body {
			margin: 0;
			font-family: system-ui;
			min-height: 100vh;
			background: linear-gradient(135deg, #1a472a, #2d5a40);
			color: white;
			display: flex;
			flex-direction: column;
			padding: 0;
		}
        
        .chart-container {
            background: rgba(255, 255, 255, 0.9);
            border-radius: 1rem;
            padding: 1rem;
            margin: 1rem 0;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
		footer {
			text-align: center;
			padding: 1rem;
			color: rgba(255, 255, 255, 0.8);
			font-size: 0.9rem;
			background-color: rgba(178, 34, 34, 0.3);
			width: 100%;
			margin-top: auto;
        }
    </style>
</head>
<body class="bg-gradient-to-br from-orange-100 to-orange-200 min-h-screen p-8">
    <div class="max-w-6xl mx-auto relative">
        <div class="bg-white/90 backdrop-blur-sm rounded-xl shadow-2xl p-8">
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

            <h1 class="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-orange-600 to-orange-400 bg-clip-text text-transparent">
                NCAA Basketball Statistics Visualizations
            </h1>
			<p class="text-center text-gray-700 mb-8">
			Data from <a href="https://www.ncaa.com/standings/basketball-women/d1" style="color: white; text-decoration: underline;" target="_blank">ncaa.com/standings/basketball-women/d1</a>
			</p>

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

            <div id="chartContainer" class="chart-container p-4 bg-white rounded-lg shadow">
                <canvas id="conferenceChart"></canvas>
            </div>
        </div>
    </div>

    <script>
        let currentChart = null;
        let currentData = null;

        async function fetchAndDisplayStats(gender = 'women') {
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
	<footer>
		Made w/ ❤️ in sf 🌁 using <a href="https://developers.cloudflare.com/workers-ai/" 
			style="color: white; text-decoration: underline;"
			target="_blank">
			Cloudflare Workers AI
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



  