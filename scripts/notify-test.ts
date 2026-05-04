// One-shot Telegram smoke test. Run after setting TELEGRAM_BOT_TOKEN
// and TELEGRAM_CHAT_ID in .env.local:
//
//   npx tsx scripts/notify-test.ts
//
// You should see the test message in the chat with your bot within
// seconds. If it fails the script prints a clear error.

import { notify } from "../lib/notify";

async function main() {
  const ok = await notify(
    "✅ *Telegram bot wired up*\n" +
      "Short That Shit notifications are live. You'll receive:\n" +
      "• 🎯 alerts on new trigger names\n" +
      "• 🔄 monthly refresh summaries\n" +
      "• ✅/❌ paper-trade close P&L"
  );
  if (!ok) {
    console.error(
      "[notify-test] failed. Check that TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in .env.local."
    );
    process.exit(1);
  }
  console.log("[notify-test] sent successfully.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
