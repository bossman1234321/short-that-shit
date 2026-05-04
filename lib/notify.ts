// Telegram notification helper. No-op when TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID env vars aren't set (so local dev runs and CI builds
// don't fail loud over missing creds). All errors are caught and logged
// to stderr — a notification failure should never crash the calling
// script.
//
// Setup:
//   1. On Telegram, message @BotFather → /newbot → save the bot token.
//   2. Message your new bot once (anything) so it has your chat in scope.
//   3. curl https://api.telegram.org/bot<TOKEN>/getUpdates → copy the
//      "chat":{"id":...} value.
//   4. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local (local)
//      and in the monthly routine prompt or environment (remote).

const TELEGRAM_API = "https://api.telegram.org";

export type NotifyOptions = {
  // "Markdown" supports *bold*, _italic_, `code`, [text](url). Default.
  // "HTML" supports <b>, <i>, <code>, <a href>. Use when content has
  // characters that conflict with Markdown.
  parseMode?: "Markdown" | "HTML";
  disablePreview?: boolean;
};

export async function notify(
  message: string,
  opts: NotifyOptions = {}
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error(
      "[notify] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; skipping."
    );
    return false;
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: opts.parseMode ?? "Markdown",
        disable_web_page_preview: opts.disablePreview ?? true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[notify] Telegram error ${res.status}: ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[notify] request failed:", err);
    return false;
  }
}
