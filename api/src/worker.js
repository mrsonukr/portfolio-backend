export default {
  async fetch(request, env, ctx) {
    // Parse the request URL
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle /api/repos/:username route (allow trailing slash or no trailing slash)
    if (path.match(/^\/api\/repos\/[^/]+\/?$/)) {
      const username = path.replace(/^\/api\/repos\//, '').replace(/\/$/, '');
      if (!username) {
        return new Response(JSON.stringify({ error: 'Username is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const cacheKey = `repos_${username}`;
      // Check KV cache for full response
      try {
        const cachedData = await env.REPO_CACHE.get(cacheKey, { type: 'json' });
        if (cachedData && Array.isArray(cachedData)) {
          return new Response(JSON.stringify(cachedData), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'X-Cache-Status': 'HIT',
            },
          });
        }
      } catch (error) {
        console.error(`KV cache read error for ${cacheKey}: ${error.message}`);
        // Continue without cache if KV fails
      }

      try {
        const response = await fetch(`https://api.github.com/users/${username}/repos?type=public&per_page=100`, {
          headers: {
            'User-Agent': 'Cloudflare-Worker',
            ...(env.GITHUB_TOKEN ? { 'Authorization': `token ${env.GITHUB_TOKEN}` } : {}),
          },
        });
        if (!response.ok) {
          return new Response(JSON.stringify({ error: `GitHub API error: ${response.statusText}` }), {
            status: response.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
        const repos = await response.json();

        if (!repos.length) {
          // Cache empty result to avoid repeated GitHub API calls
          try {
            await env.REPO_CACHE.put(cacheKey, JSON.stringify([]), { expirationTtl: 300 });
          } catch (error) {
            console.error(`KV cache write error for ${cacheKey}: ${error.message}`);
          }
          return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        const repoPromises = repos.map(async (repo) => {
          const projectJsonCacheKey = `project_json_${username}_${repo.name}`;
          let projectData = null;

          // Check KV cache for project.json
          try {
            const cachedProjectData = await env.REPO_CACHE.get(projectJsonCacheKey, { type: 'json' });
            if (cachedProjectData) {
              projectData = cachedProjectData;
            }
          } catch (error) {
            console.error(`KV cache read error for ${projectJsonCacheKey}: ${error.message}`);
          }

          // Fetch project.json if not cached
          if (!projectData) {
            try {
              const jsonResponse = await fetch(`https://raw.githubusercontent.com/${username}/${repo.name}/${repo.default_branch}/project.json`);
              if (!jsonResponse.ok) {
                return null;
              }
              projectData = await jsonResponse.json();
              if (!projectData.banner && !projectData.demoLink) {
                return null;
              }
              // Cache project.json (longer TTL since it changes less frequently)
              try {
                await env.REPO_CACHE.put(projectJsonCacheKey, JSON.stringify(projectData), { expirationTtl: 3600 }); // 1 hour
              } catch (error) {
                console.error(`KV cache write error for ${projectJsonCacheKey}: ${error.message}`);
              }
            } catch (error) {
              console.error(`Error fetching project.json for ${repo.name}: ${error.message}`);
              return null;
            }
          }

          if (projectData) {
            return {
              name: repo.name,
              html_url: repo.html_url,
              description: repo.description || 'No description available',
              banner: projectData.banner || 'https://via.placeholder.com/600x200?text=No+Banner',
              demoLink: projectData.demoLink || '',
            };
          }
          return null;
        });

        const repoData = (await Promise.all(repoPromises)).filter((repo) => repo !== null);

        // Store full response in KV cache (5-minute TTL)
        try {
          await env.REPO_CACHE.put(cacheKey, JSON.stringify(repoData), { expirationTtl: 300 });
        } catch (error) {
          console.error(`KV cache write error for ${cacheKey}: ${error.message}`);
        }

        return new Response(JSON.stringify(repoData), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cache-Status': 'MISS',
          },
        });
      } catch (error) {
        console.error(`Server error for username ${username}: ${error.message}`);
        return new Response(JSON.stringify({ error: `Server error: ${error.message}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // Return 404 for other routes
    return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  },
};