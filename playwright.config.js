const { defineConfig, devices } = require('@playwright/test');

// Serves the project root exactly the way local dev already does (see
// README.md's own "python -m http.server 5500") -- no build step, no extra
// server dependency, same unminified css/js the real site serves in dev.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5500',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'python -m http.server 5500',
    url: 'http://127.0.0.1:5500/account.html',
    reuseExistingServer: !process.env.CI,
    timeout: 20000
  },
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    // Mobile Chrome's own device descriptor (Chromium engine, no separate
    // WebKit browser download needed) -- covers the 390px-width/touch-input
    // requirement without pulling in a second browser binary.
    { name: 'Mobile Chrome', use: { ...devices['Pixel 7'] } }
  ]
});
