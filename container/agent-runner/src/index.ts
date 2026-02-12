/**
 * Maxwell Agent Runner (Gemini)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { 
  LlmAgent, 
  FunctionTool, 
  Runner, 
  InMemorySessionService,
} from '@google/adk';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Filesystem and Bash Tools
 */

const bashTool = new FunctionTool({
  name: 'bash',
  description: 'Run a bash command in the container. Returns stdout and stderr.',
  parameters: z.object({
    command: z.string().describe('The command to run'),
  }),
  execute: async ({ command }) => {
    try {
      const output = execSync(command, { encoding: 'utf-8', shell: '/bin/bash' });
      return { status: 'success', output };
    } catch (err) {
      return { 
        status: 'error', 
        error: err instanceof Error ? err.message : String(err),
        stderr: (err as { stderr?: string }).stderr 
      };
    }
  },
});

const readFileTool = new FunctionTool({
  name: 'read_file',
  description: 'Read the contents of a file.',
  parameters: z.object({
    path: z.string().describe('Relative path to the file from /workspace/group'),
  }),
  execute: async ({ path: filePath }) => {
    try {
      const fullPath = path.resolve('/workspace/group', filePath);
      if (!fullPath.startsWith('/workspace/')) {
        throw new Error('Access denied: path must be inside /workspace');
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { status: 'success', content };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const writeFileTool = new FunctionTool({
  name: 'write_file',
  description: 'Write content to a file. Overwrites if it exists.',
  parameters: z.object({
    path: z.string().describe('Relative path to the file from /workspace/group'),
    content: z.string().describe('The content to write'),
  }),
  execute: async ({ path: filePath, content }) => {
    try {
      const fullPath = path.resolve('/workspace/group', filePath);
      if (!fullPath.startsWith('/workspace/')) {
        throw new Error('Access denied: path must be inside /workspace');
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      return { status: 'success', message: `File written to ${filePath}` };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const listFilesTool = new FunctionTool({
  name: 'list_files',
  description: 'List files in a directory.',
  parameters: z.object({
    path: z.string().describe('Relative path to the directory from /workspace/group'),
  }),
  execute: async ({ path: dirPath }) => {
    try {
      const fullPath = path.resolve('/workspace/group', dirPath);
      if (!fullPath.startsWith('/workspace/')) {
        throw new Error('Access denied: path must be inside /workspace');
      }
      const files = fs.readdirSync(fullPath);
      return { status: 'success', files };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
});

/**
 * MCP Integration (Manual)
 */
async function createMcpTools(mcpServerPath: string, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpServerPath],
    env,
  });

  const client = new Client({
    name: 'maxwell-agent-runner',
    version: '1.0.0',
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();

  return mcpTools.map((tool: any) => new FunctionTool({
    name: `mcp__nanoclaw__${tool.name}`,
    description: tool.description || '',
    parameters: z.object({}).passthrough().describe('Parameters for the MCP tool'),
    execute: async (args) => {
      const result = await client.callTool({
        name: tool.name,
        arguments: args,
      });
      return result;
    },
  }));
}

/**
 * IPC Handling
 */
function drainIpcInput(): string[] {
  try {
    if (!fs.existsSync(IPC_INPUT_DIR)) return [];
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function main() {
  let containerInput: ContainerInput;
  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const globalMaxwellMdPath = '/workspace/global/MAXWELL.md';
  const groupMaxwellMdPath = '/workspace/group/MAXWELL.md';
  
  let instructions = 'You are Maxwell, a personal assistant.';
  if (fs.existsSync(globalMaxwellMdPath)) {
    instructions += '\n\n' + fs.readFileSync(globalMaxwellMdPath, 'utf-8');
  }
  if (fs.existsSync(groupMaxwellMdPath)) {
    instructions += '\n\n' + fs.readFileSync(groupMaxwellMdPath, 'utf-8');
  }

  // Manual MCP integration
  const mcpTools = await createMcpTools(mcpServerPath, {
    NANOCLAW_CHAT_JID: containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
  });

  const agent = new LlmAgent({
    name: 'Maxwell',
    model: 'gemini-1.5-pro',
    instruction: instructions,
    tools: [
      bashTool,
      readFileTool,
      writeFileTool,
      listFilesTool,
      ...mcpTools,
    ],
  });

  const runner = new Runner({
    agent,
    appName: 'maxwell',
    sessionService: new InMemorySessionService(),
  });

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  // Session ID for ADK
  const sessionId = containerInput.sessionId || `session-${Date.now()}`;

  try {
    while (true) {
      log(`Running agent turn...`);
      
      // Use correct arguments for runAsync: single object
      const eventStream = runner.runAsync({
        userId: containerInput.chatJid, // Use chat JID as user ID
        sessionId,
        newMessage: {
          role: 'user',
          parts: [{ text: prompt }]
        }
      });

      let finalResult = '';
      
      for await (const event of eventStream) {
        // Inspect content parts for text
        if (event.content && event.content.parts) {
          for (const part of event.content.parts) {
            if (part.text) {
              finalResult += part.text;
            }
          }
        }
        
        // Log other activities (tool use might be in actions or content)
        if (event.actions) {
          log(`Action received: ${JSON.stringify(event.actions).slice(0, 100)}`);
        }
      }
      
      writeOutput({
        status: 'success',
        result: finalResult,
        newSessionId: sessionId,
      });

      log('Waiting for next IPC message...');
      let nextMessage: string | null = null;
      while (!nextMessage) {
        if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
          fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
          nextMessage = null;
          break;
        }
        const pending = drainIpcInput();
        if (pending.length > 0) {
          nextMessage = pending.join('\n');
          break;
        }
        await new Promise(r => setTimeout(r, IPC_POLL_MS));
      }

      if (!nextMessage) break;
      prompt = nextMessage;
    }
  } catch (err) {
    log(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
    writeOutput({ status: 'error', result: null, error: String(err) });
    process.exit(1);
  }
}

main();