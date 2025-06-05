import { Router } from 'itty-router';

// Initialize router
const router = Router();

// Cache duration (5 minutes in seconds)
const CACHE_TTL = 300;

// API route to fetch repositories
router.get('/api/repos/:username', async ({ params }, { REPO_CACHE }) => {
  const username = params.username;
  const cacheKey = `repos_${username}`;
  
  // Check KV cache
  const cachedData = await REPO_CACHE.get(cacheKey, { type: 'json' });
  if (cachedData) {
    return new Response(JSON.stringify(cachedData), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const response = await fetch(`https://api.github.com/users/${username}/repos?type=public&per_page=100`, {
      headers: { 'User-Agent': 'Cloudflare-Worker' },
    });
    if (!response.ok) {
      throw new Error('User not found or API error');
    }
    const repos = await response.json();

    if (!repos.length) {
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const repoPromises = repos.map(async (repo) => {
      try {
        const jsonResponse = await fetch(`https://raw.githubusercontent.com/${username}/${repo.name}/${repo.default_branch}/project.json`);
        if (!jsonResponse.ok) {
          return null;
        }
        const projectData = await jsonResponse.json();
        if (!projectData.banner && !projectData.demoLink) {
          return null;
        }
        return {
          name: repo.name,
          html_url: repo.html_url,
          description: repo.description || 'No description available',
          banner: projectData.banner || 'https://via.placeholder.com/600x200?text=No+Banner',
          demoLink: projectData.demoLink || '',
        };
      } catch (error) {
        return null;
      }
    });

    const repoData = (await Promise.all(repoPromises)).filter((repo) => repo !== null);
    
    // Store in KV cache
    await REPO_CACHE.put(cacheKey, JSON.stringify(repoData), { expirationTtl: CACHE_TTL });

    return new Response(JSON.stringify(repoData), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'User not found or API error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});

// Handle all other routes by returning 404
router.all('*', () => new Response('Not Found', { status: 404 }));

// Worker entry point
export default {
  fetch: router.handle,
};