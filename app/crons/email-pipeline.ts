import type { CronHandler } from "~/lib/appapprove-config";
import { runMigrations } from "~/lib/db/migrate.server";
import { runEmailPipeline } from "~/lib/email-pipeline.server";

// CF Cron handler — fired by the */15 * * * * trigger. Scans email_jobs
// for due rows and sends them. Ratchets request → reminder stage and
// skips orders the customer already reviewed.
const handler: CronHandler = async ({ schedule, scheduledAt, context }) => {
  await runMigrations(context);
  const result = await runEmailPipeline(context);
  console.log(
    `[cron] ${schedule} email-pipeline @${new Date(scheduledAt).toISOString()}`,
    result,
  );
};

export default handler;
