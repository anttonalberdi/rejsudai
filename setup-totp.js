require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page = await browser.newPage();

  // --- LOGIN ---
  await page.goto('https://indfak2.dk/login/#/');
  await page.locator('#select_value_label_0').click();
  await page.getByText('English').click();
  await page.getByRole('textbox', { name: 'User name' }).fill(process.env.INDFAK_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.INDFAK_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();

  const code = await prompt('Enter your current TOTP code from the authenticator app: ');
  await page.getByRole('textbox', { name: 'Code *' }).fill(code);
  await page.getByRole('button', { name: 'Ok' }).click();

  try {
    await page.getByRole('button', { name: 'Expense' }).waitFor({ timeout: 10000 });
    console.log('Logged in successfully.');
  } catch {
    console.error('Login failed — wrong code? Exiting.');
    await browser.close();
    process.exit(1);
  }

  // --- HAND OVER TO USER ---
  console.log('\nNavigate to your account / security settings and start the TOTP re-enrollment.');
  console.log('When the QR code appears, I will extract the secret automatically.');
  console.log('(The browser inspector is open — click Resume when ready to start scanning.)\n');

  // Intercept any page that contains an otpauth:// URI (the QR code source)
  let foundSecret = null;

  page.on('response', async response => {
    try {
      const body = await response.text();
      const match = body.match(/otpauth:\/\/totp\/[^"'\s]*/);
      if (match) {
        const uri = decodeURIComponent(match[0]);
        const secretMatch = uri.match(/[?&]secret=([A-Z2-7]+)/i);
        if (secretMatch) {
          foundSecret = secretMatch[1];
          console.log(`\nFound TOTP secret in network response: ${foundSecret}`);
        }
      }
    } catch {}
  });

  // Also poll the page DOM for otpauth URIs (shown as text or in img src)
  const pollSecret = setInterval(async () => {
    if (foundSecret) return;
    try {
      const content = await page.content();
      const match = content.match(/otpauth:\/\/totp\/[^"'\s<]*/);
      if (match) {
        const uri = decodeURIComponent(match[0]);
        const secretMatch = uri.match(/[?&]secret=([A-Z2-7]+)/i);
        if (secretMatch && secretMatch[1] !== foundSecret) {
          foundSecret = secretMatch[1];
          console.log(`\nFound TOTP secret in page DOM: ${foundSecret}`);
        }
      }
    } catch {}
  }, 1000);

  await page.pause(); // user navigates and re-enrolls TOTP here

  clearInterval(pollSecret);

  if (!foundSecret) {
    // Last attempt: scan full page content
    const content = await page.content();
    const match = content.match(/otpauth:\/\/totp\/[^"'\s<]*/);
    if (match) {
      const uri = decodeURIComponent(match[0]);
      const secretMatch = uri.match(/[?&]secret=([A-Z2-7]+)/i);
      if (secretMatch) foundSecret = secretMatch[1];
    }
  }

  if (foundSecret) {
    // Update .env
    let env = fs.readFileSync('.env', 'utf8');
    env = env.replace(/^TOTP_SECRET=.*$/m, `TOTP_SECRET=${foundSecret}`);
    fs.writeFileSync('.env', env);
    console.log(`\nTOTP_SECRET updated in .env: ${foundSecret}`);
    console.log('You can now run: node bot.js <invoice>');
  } else {
    console.log('\nCould not extract secret automatically.');
    console.log('Look for a "manual entry" or "secret key" text on the QR code page and add it to .env as TOTP_SECRET=...');
  }

  await browser.close();
}

run().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
