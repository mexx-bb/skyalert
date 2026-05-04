const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

// Mock browser globals required by api.js
const localStorageMock = {
  store: {},
  getItem(key) { return this.store[key] || null; },
  setItem(key, value) { this.store[key] = String(value); },
  removeItem(key) { delete this.store[key]; },
  clear() { this.store = {}; }
};

const context = vm.createContext({
  localStorage: localStorageMock,
  navigator: {},
  URL: class URL {},
  console: console
});

const apiCode = fs.readFileSync('api.js', 'utf8');

// The code sets const AviationAPI = (() => { ... })();
// To capture it in the context:
vm.runInContext(apiCode + '; var _AviationAPI = AviationAPI;', context);
const AviationAPI = context._AviationAPI;

test('computeAirlineStats - division by zero prevention', () => {
  // Test 1: Empty array should return an empty array
  const emptyStats = AviationAPI.computeAirlineStats([]);
  assert.strictEqual(emptyStats.length, 0);

  // Test 2: Flight with no delay (delayedCount = 0)
  const noDelayStats = AviationAPI.computeAirlineStats([{
    airlineIata: 'LH',
    airline: 'Lufthansa',
    status: 'ontime' // not delayed, so delayedCount will be 0
  }]);

  assert.strictEqual(noDelayStats.length, 1);
  assert.strictEqual(noDelayStats[0].punctuality, '100%');
  // If logic was flawed, this might evaluate to NaNmin
  assert.strictEqual(noDelayStats[0].avgDelay, '0min');

  // Test 3: Delayed flight with 0 delay (delayedCount > 0 but totalDelay = 0)
  const zeroDelayStats = AviationAPI.computeAirlineStats([{
    airlineIata: 'BA',
    airline: 'British Airways',
    status: 'delayed',
    delay: 0
  }]);

  assert.strictEqual(zeroDelayStats.length, 1);
  assert.strictEqual(zeroDelayStats[0].punctuality, '0%');
  assert.strictEqual(zeroDelayStats[0].avgDelay, '0min');

  // Test 4: Flight with unknown status (ontime = 0, total = 1)
  const unknownStatusStats = AviationAPI.computeAirlineStats([{
    airlineIata: 'AF',
    airline: 'Air France',
    status: 'unknown'
  }]);

  assert.strictEqual(unknownStatusStats.length, 1);
  assert.strictEqual(unknownStatusStats[0].punctuality, '0%');
  assert.strictEqual(unknownStatusStats[0].avgDelay, '0min');

  // Test 5: Multiple flights to ensure averages calculate correctly
  const mixedStats = AviationAPI.computeAirlineStats([
    { airlineIata: 'DL', airline: 'Delta', status: 'ontime' },
    { airlineIata: 'DL', airline: 'Delta', status: 'delayed', delay: 30 },
    { airlineIata: 'DL', airline: 'Delta', status: 'delayed', delay: 60 }
  ]);

  assert.strictEqual(mixedStats.length, 1);
  assert.strictEqual(mixedStats[0].punctuality, '33%'); // 1 ontime out of 3 total -> ~33%
  assert.strictEqual(mixedStats[0].avgDelay, '45min');  // (30 + 60) / 2 = 45
});
