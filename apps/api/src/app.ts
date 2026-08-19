/**
 * REMOVED — do not reintroduce.
 *
 * This module used to export `createApp()`, which built a second Express
 * application with:
 *   - no authentication on any route,
 *   - no rate limiting, and
 *   - its own `new BotState()`, separate from the one the real server uses.
 *
 * That is two problems at once. Importing it anywhere would have served an
 * entirely unauthenticated API, and because it carried an independent
 * BotState, the status and positions it reported would have been a
 * different (always-empty) reality from the running bot's — the classic
 * split-brain that makes an operator trust a dashboard showing nothing
 * wrong.
 *
 * The single wired application lives in ./index.ts. Tests should import
 * that, or construct routes directly via `createRoutes(state)`.
 */

export function createApp(): never {
  throw new Error(
    'apps/api/src/app.ts::createApp has been removed because it built an ' +
      'unauthenticated Express app with a separate BotState. Use the ' +
      'application exported from ./index.ts instead.',
  );
}
