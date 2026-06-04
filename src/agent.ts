import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from "ai";

const MAX_TURN = 10;

interface AgentLoopParameter {
  model: LanguageModel;
  systemPrompt: string;
  tools: ToolSet | Tool[];
  messages: ModelMessage[];
}

// support tools as array or object, if array, convert to object with title as key
const resolveTools = (tools: ToolSet | Tool[]): ToolSet => {
  if (!Array.isArray(tools)) {
    return tools;
  }

  return tools.reduce<ToolSet>((resolvedTools, tool) => {
    const title = tool.title?.trim();

    if (!title) {
      throw new Error("Tool arrays require every tool to have a title.");
    }

    if (Object.hasOwn(resolvedTools, title)) {
      throw new Error(`Duplicate tool title: ${title}`);
    }

    resolvedTools[title] = tool;
    return resolvedTools;
  }, {});
};

export const agentLoop = async ({
  model,
  systemPrompt,
  tools,
  messages,
}: AgentLoopParameter) => {
  let turn = 0;

  while (turn < MAX_TURN) {
    turn++;
    console.log(`\n--- Agent Loop Turn ${turn} ---\n`);

    const result = streamText({
      model,
      system: systemPrompt,
      tools: resolveTools(tools),
      messages,
    });

    let needToolCall = false;
    let fullContent = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          process.stdout.write(part.text);
          fullContent += part.text;
          break;
        }
        case "tool-call": {
          needToolCall = true;
          console.log(
            `\n  [tool called: ${part.toolName}->(${JSON.stringify(part.input)})]`,
          );
          break;
        }
        case "tool-result": {
          console.log(
            `  [tool called result: ${part.toolName}->${JSON.stringify(part.output)}]`,
          );
          break;
        }
      }
    }

    const fullMessage = await result.response;

    messages.push(...fullMessage.messages);

    if (!needToolCall) {
      console.log("\nAgent has completed its response. Ending loop.");
      break;
    }

    console.log("agent needs to call tool, continue to next turn");
  }

  if (turn >= MAX_TURN) {
    console.log(
      "\nReached maximum turn limit. Ending loop to prevent infinite execution.",
    );
  }
};
