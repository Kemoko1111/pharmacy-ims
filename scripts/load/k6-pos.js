/**
 * Week 7 load test (course brief: "thousands of users" exercise).
 * Read-heavy POS profile: catalogue search + barcode lookups + dashboard,
 * with an optional sale-burst mode against a THROWAWAY database.
 *
 *   k6 run scripts/load/k6-pos.js
 *   k6 run -e BASE=https://api.example.com -e SALES=true scripts/load/k6-pos.js
 *
 * Thresholds mirror the api-schema.md target: product search < 300 ms p95.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3000';
const USERNAME = __ENV.USERNAME || 'akosua';
const PASSWORD = __ENV.PASSWORD || 'ChangeMe123!';
const DO_SALES = __ENV.SALES === 'true';

const searchTrend = new Trend('search_duration', true);

export const options = {
  scenarios: {
    tills: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '2m', target: 20 },
        { duration: '30s', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    search_duration: ['p(95)<300'], // GET /products target (api-schema.md)
    http_req_duration: ['p(95)<800'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ username: USERNAME, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login ok': (r) => r.status === 200 });
  return { token: res.json('accessToken') };
}

const SEARCHES = ['para', 'amox', 'vitamin', 'syrup', 'ors', 'ibu', 'metf'];

export default function (data) {
  const auth = { headers: { Authorization: `Bearer ${data.token}` } };

  const q = SEARCHES[Math.floor(Math.random() * SEARCHES.length)];
  const search = http.get(`${BASE}/api/v1/products?q=${q}&pageSize=20`, auth);
  searchTrend.add(search.timings.duration);
  check(search, { 'search 200': (r) => r.status === 200 });

  http.get(`${BASE}/api/v1/barcodes/6151100010024`, auth);
  http.get(`${BASE}/health`);

  if (__ITER % 5 === 0) {
    http.get(`${BASE}/api/v1/reports/daily`, auth);
  }

  if (DO_SALES && __ITER % 10 === 0) {
    const products = search.json('data');
    if (products && products.length > 0 && products[0].qtyOnHand > 5) {
      const p = products[0];
      const sale = {
        clientSaleId: crypto.randomUUID(),
        soldAt: new Date().toISOString(),
        items: [{ productId: p.id, quantity: 1, unitPrice: String(p.sellingPriceBase) }],
        payments: [{ method: 'CASH', amount: String(p.sellingPriceBase) }],
      };
      const res = http.post(`${BASE}/api/v1/sales`, JSON.stringify(sale), {
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
      });
      check(res, { 'sale 201/422': (r) => r.status === 201 || r.status === 422 });
    }
  }

  sleep(Math.random() * 2 + 0.5);
}
