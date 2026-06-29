const https = require('https');

const COOKIES = {
  'Account#1 (11601081906)': 'csrftoken=aNkkZeQAuFHCS5W30T0Kn9s1tYWkAQGV; datr=N9FCalC-sW43OcbcaQg6vov2; ds_user_id=11601081906; ig_did=F568DE2F-795B-4CDA-8165-B5521E280DBF; mid=akLRNwAEAAGEqCO4F8D35xkW4OSW; sessionid=11601081906%3ASPxsNBjo3McqG9%3A9%3AAYhOBaNsQvEQXLdBauZyZtcKWqzaKLzuGGiBL_JHnA',
  'Account#2 (22298657725)': 'csrftoken=qZnaHpOUW2IeRqfxSi2BeGLWe3au4D4O; datr=xNJCarS5DIJArO9bn0bvGlDI; ds_user_id=22298657725; ig_did=52723CF1-5C98-497B-8AEB-81CD060C45F6; mid=akLSxAAEAAHvmXg4h8erTDAdiErO; sessionid=22298657725%3AWrsAkymmu7Hdg7%3A9%3AAYjUzGngCNLt_X83sb7yGSfyYadWvnawuP5a8fdVHw',
  'Account#3 (10390730118)': 'csrftoken=OuR7SnMNlaMKT3R4i34fWWYMzPpwf1sI; datr=mNNCampSjNSlh-JtEBBOIpyf; ds_user_id=10390730118; ig_did=9A6395BD-3940-467C-A852-479958F48FCA; mid=akLTmAAEAAEemI7pHsArxy4nVdtn; ps_l=1; ps_n=1; sessionid=10390730118%3A6FbJJLyhGTc8cO%3A17%3AAYi9lLckd4vzMHQA8P8a8JpDqhFljDxp9IDRpsY8Bg',
};

const DOC_IDS = [
  '9510064595728286',
  '8845758582119845',
  '17991233890441503',
  '2527888987554512',
  '8180449582030218',
  '10015854995750756',
];

const SHORTCODE = 'DaI6q9VNzUN';

function testRequest(accountName, cookie, docId) {
  return new Promise((resolve) => {
    const body = `doc_id=${docId}&variables=${encodeURIComponent(JSON.stringify({ shortcode: SHORTCODE }))}`;
    const options = {
      hostname: 'www.instagram.com',
      path: '/graphql/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'X-IG-App-ID': '936619743392459',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const isHtml = data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html');
        const isLoggedIn = data.includes('logged-in');
        let result = '';
        if (!isHtml) {
          try {
            const json = JSON.parse(data);
            const media = json?.data?.xdt_shortcode_media || json?.data?.shortcode_media;
            result = media ? `✅ SUCCESS! type=${media.__typename}` : `⚠️  JSON but no media. Keys: ${JSON.stringify(Object.keys(json?.data || {}))}`;
          } catch(e) {
            result = `⚠️  Non-HTML non-JSON: ${data.substring(0, 80)}`;
          }
        } else {
          result = isLoggedIn ? '🔐 logged-in but Page Not Found (wrong doc_id)' : '❌ not-logged-in (cookie expired)';
        }
        resolve({ accountName, docId, status: res.statusCode, result });
      });
    });

    req.on('error', (e) => resolve({ accountName, docId, status: 'ERR', result: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ accountName, docId, status: 'TIMEOUT', result: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Testing all cookies × all doc_ids...\n');
  const tasks = [];
  for (const [accountName, cookie] of Object.entries(COOKIES)) {
    for (const docId of DOC_IDS) {
      tasks.push(testRequest(accountName, cookie, docId));
    }
  }
  const results = await Promise.all(tasks);
  for (const r of results) {
    console.log(`[${r.accountName}] doc_id=${r.docId} => HTTP ${r.status} | ${r.result}`);
  }
}

main();
