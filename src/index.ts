import { Command } from "commander";
import { createAgent, listAssistants, wipeVapi } from "./actions.js";
import { VapiError } from "./vapi.js";

const program = new Command();

program
  .name("vapi-couchbase")
  .description("Create a Vapi OrderBot assistant that calls Couchbase MCP")
  .showHelpAfterError();

program
  .command("create")
  .description("Create OrderBot and attach the public HTTPS MCP URL")
  .option("-n, --name <name>", "Assistant name (max 40 chars)")
  .requiredOption("--mcp-url <url>", "Public HTTPS Couchbase MCP URL ending with /mcp")
  .option("--replace", "Update the last created assistant/tool instead of creating new ones")
  .action(async (opts: { name?: string; mcpUrl: string; replace?: boolean }) => {
    const result = await createAgent(opts);
    console.log(result.replaced ? "Updated" : "Created", "assistant", result.assistantId);
    console.log("MCP URL", result.mcpUrl);
    console.log("Approval UI", result.approvalUiUrl);
    console.log("\nOpen OrderBot in Vapi:");
    console.log(result.dashboardUrl);
    console.log("Use Talk. Keep Docker and the Cloudflare tunnel running.");
  });

program
  .command("wipe")
  .description("Delete every Vapi assistant and tool in this account")
  .action(async () => {
    const result = await wipeVapi();
    console.log("Deleted assistants", result.deletedAssistants);
    console.log("Deleted tools", result.deletedTools);
  });

program
  .command("list")
  .description("List Vapi assistants in this account")
  .action(async () => {
    const assistants = await listAssistants();
    if (assistants.length === 0) {
      console.log("No assistants found.");
      return;
    }
    for (const assistant of assistants) {
      console.log(`${assistant.id}\t${assistant.name ?? "(unnamed)"}\t${assistant.createdAt ?? ""}`);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof VapiError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
