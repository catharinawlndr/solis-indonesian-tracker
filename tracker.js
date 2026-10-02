
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const CONFIG = {
  url: 'https://utest-nyc-solis-id.youcanbook.me/',
  stateFile: 'solis-state.json',
  timeout: 45000
};

const PREFIX = '[SOLIS CLOUD]';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

const months = [
  'January', 'February', 'March', 'April',
  'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'
];

function log(message) {
  console.log(`${PREFIX} ${message}`);
}

// Retrieve availability saved by a previous GitHub run.
async function readPreviousState() {
  try {
    const content = await fs.readFile(
      CONFIG.stateFile,
      'utf8'
    );

    const state = JSON.parse(content);

    return Array.isArray(state.dates)
      ? state.dates
      : [];

  } catch (error) {
    if (error.code === 'ENOENT') {
      log('No previous state found. Starting fresh.');
      return null;
    }

    throw error;
  }
}

// Save the latest successfully checked dates.
async function saveState(dates) {
  await fs.writeFile(
    CONFIG.stateFile,
    JSON.stringify({
      dates,
      lastChecked: new Date().toISOString()
    }, null, 2)
  );
}

// Send an alert through your existing Telegram bot.
async function sendTelegram(message) {
  if (!token || !chatId) {
    throw new Error(
      'Telegram GitHub Secrets are missing.'
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram rejected the message: ${result.description || response.status}`
    );
  }

  log('Telegram notification delivered successfully.');
}

// Inspect the currently displayed SOLIS calendar.
async function inspectCalendar(page) {
  return await page.evaluate(() => {
    const pageText = document.body.innerText;

    const noAvailability =
      pageText.includes('No Availability');

    const cells = [
      ...document.querySelectorAll('[role="gridcell"]')
    ];

    const dates = cells
      .filter(cell => {
        const button = cell.querySelector('button');

        if (!button) return false;

        const day = button.innerText.trim();

        return (
          /^\d{1,2}$/.test(day) &&
          !button.disabled &&
          button.getAttribute('aria-disabled') !== 'true'
        );
      })
      .map(cell => cell.querySelector('button').innerText.trim());

    const monthYear = pageText.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/
    );

    return {
      noAvailability,
      calendarFound: cells.length > 0,
      monthYear: monthYear ? monthYear[0] : null,
      dates
    };
  });
}

async function main() {
  log('Starting Indonesian SOLIS availability check.');

  const browser = await chromium.launch({
    headless: true
  });

  try {
    const page = await browser.newPage({
      timezoneId: 'America/New_York',
      locale: 'en-US'
    });

    await page.goto(CONFIG.url, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.timeout
    });

    // Allow the booking calendar to finish rendering.
    await page.waitForTimeout(8000);

    const result = await inspectCalendar(page);

    log(`Calendar month: ${result.monthYear}`);
    log(`No Availability message: ${result.noAvailability}`);
    log(`Detected dates: ${JSON.stringify(result.dates)}`);

    // Safety: do not treat incomplete rendering as availability.
    if (!result.monthYear) {
      throw new Error(
        'Calendar month could not be identified.'
      );
    }

    if (!result.noAvailability && !result.calendarFound) {
      throw new Error(
        'Calendar did not finish loading.'
      );
    }

    if (!result.noAvailability && result.dates.length === 0) {
      throw new Error(
        'Calendar state uncertain. Previous data preserved.'
      );
    }

    const current = result.noAvailability
      ? []
      : result.dates.map(
          day => `${result.monthYear} — ${day}`
        );

    const previous = await readPreviousState();

    // First run establishes a baseline.
    // However, if dates are already available, notify immediately.
    const newDates = previous === null
      ? current
      : current.filter(date => !previous.includes(date));

    if (newDates.length > 0) {
      log(`NEW SELECTABLE DATES: ${newDates.join(', ')}`);

      const message =
  '🚨 SOLIS INDONESIAN — SLOT ALERT!\n\n' +
  'Newly selectable dates:\n' +
  newDates.join('\n') +
  '\n\n👇 OPEN BOOKING CALENDAR NOW:\n' +
  'https://utest-nyc-solis-id.youcanbook.me/\n\n' +
  'Please verify the available appointment times and book immediately.\n\n' +
  'Automatically detected by GitHub Cloud Tracker.';

      await sendTelegram(message);

    } else {
      log('No newly selectable dates.');
    }

        await saveState(current);

    log('Availability check completed successfully.');

  } finally {
    await browser.close();
  }
}

// TEMPORARY TELEGRAM TEST — REMOVE AFTER TESTING
sendTelegram(
  '🧪 TEST ONLY — SOLIS INDONESIAN TRACKER\n\n' +
  'Your clickable booking link is working:\n\n' +
  'https://utest-nyc-solis-id.youcanbook.me/\n\n' +
  'This is NOT an actual appointment opening.'
).catch(error => {
  console.error(PREFIX, 'Telegram test failed:', error.message);
});

main().catch(error => {
  console.error(PREFIX, error.message);
  process.exitCode = 1;
});
