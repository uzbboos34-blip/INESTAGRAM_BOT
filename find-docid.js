const https = require('https');

// Instagram sahifasidan hozirgi GraphQL doc_id larni topish
const COOKIE = 'csrftoken=aNkkZeQAuFHCS5W30T0Kn9s1tYWkAQGV; datr=N9FCalC-sW43OcbcaQg6vov2; ds_user_id=11601081906; ig_did=F568DE2F-795B-4CDA-8165-B5521E280DBF; mid=akLRNwAEAAGEqCO4F8D35xkW4OSW; sessionid=11601081906%3ASPxsNBjo3McqG9%3A9%3AAYhOBaNsQvEQXLdBauZyZtcKWqzaKLzuGGiBL_JHnA';

function fetchPage(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.instagram.com',
      path,
      method: 'GET',
      headers: {
        'Cookie': COOKIE,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    };
    
    let data = '';
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        console.log('Redirect to:', loc);
        resolve('');
        return;
      }
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  console.log('Fetching Instagram reel page to find doc_ids...');
  
  const html = await fetchPage('/reel/DaI6q9VNzUN/');
  
  if (!html) {
    console.log('Empty response - check redirect');
    return;
  }
  
  console.log(`Page length: ${html.length}`);
  console.log(`Is logged in: ${html.includes('logged-in')}`);
  
  // Find all doc_id occurrences
  const docIdRegex = /"doc_id"\s*:\s*"?(\d{10,})"?/g;
  const docIds = new Set();
  let match;
  while ((match = docIdRegex.exec(html)) !== null) {
    docIds.add(match[1]);
  }
  
  // Also look for require("PolarisPost") or similar
  const requireRegex = /require\("(\d{10,})"\)/g;
  while ((match = requireRegex.exec(html)) !== null) {
    docIds.add(match[1]);
  }

  // Search for JS bundle URLs
  const bundleRegex = /https:\/\/static\.cdninstagram\.com\/rsrc\.php\/[^\s"']+\.js/g;
  const bundles = [];
  while ((match = bundleRegex.exec(html)) !== null) {
    bundles.push(match[0]);
  }
  
  console.log('\n=== Found doc_ids in page HTML ===');
  if (docIds.size > 0) {
    for (const id of docIds) {
      console.log(' -', id);
    }
  } else {
    console.log('No doc_ids found in HTML');
  }
  
  console.log('\n=== JS Bundle URLs (first 5) ===');
  bundles.slice(0, 5).forEach(b => console.log(' -', b));
  
  // Save page for inspection
  const fs = require('fs');
  fs.writeFileSync('/tmp/ig_page.html', html);
  console.log('\nFull page saved to /tmp/ig_page.html');
}

main().catch(console.error);
