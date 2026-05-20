# pi-llama-watch

**pi-llama-watch** is an extension for the Pi coding-agent that displays real-time status of Llama LLM slots in Pi’s status bar. It shows prompt processing progress (as a percentage in amber) and token generation speed (as `t/s` in green), supporting single or multiple slots.

## Features

- Prompt processing progress (%) via system logs (journalctl)
- Token generation speed (`t/s`) via the `\/slots` API
- Multi-slot display (comma-separated, with truncation)
- Theme-aware colors: amber for processing, green for generating
- Toggle on/off with a Pi command

## Installation

Install directly into Pi via Git:

```bash
pi install git:https://github.com/LiTLiTschi/pi-llama-watch
```

This will clone the extension and make it available in your Pi environment.

## Usage

Control the status display with the `/llama-watch` command:

```bash
/llama-watch on       # Enable display
/llama-watch off      # Disable display
/llama-watch toggle   # Toggle on/off
```

## Configuration

- **LLAMA_PORT** (default: `8080`): TCP port where the Llama server exposes its `/slots` endpoint.
- **LLAMA_SERVICE** (default: `llama`): systemd service name for journalctl log parsing.

Example:

```bash
export LLAMA_PORT=8081
export LLAMA_SERVICE="my-llama-service"
```

## Status Bar Display

| State      | Example       | Color |
| ---------- | ------------- | ----- |
| Processing | `88%`         | Amber |
| Generating | `213t/s`      | Green |
| Multiple   | `10%, 250t/s` | Mixed |
| Inactive   | `-`           | Dim   |
| Idle       | (hidden)      | —     |

## Architecture

```
src/
├── LlamaState.ts       # Polls /slots API + journalctl, computes SlotInfo[]
├── format.ts           # formatProcessing, formatGenerating, formatState
├── index.ts            # Pi extension entry point (widget + commands)
├── LlamaState.test.ts  # Unit tests for LlamaState logic
└── format.test.ts      # Unit tests for formatting functions
```

1. **LlamaState** polls the Llama server every second and merges journalctl data to distinguish prompt processing vs generation.
2. **format** modules convert numeric progress or TPS into user-friendly strings.
3. **index.ts** registers commands and updates the Pi UI widget.

## Running Tests

Install dependencies and run Vitest:

```bash
npm install
npm test
# or
npm run test
```

## Contributing

Contributions welcome! Please fork, add tests for any new behavior, and submit a pull request. Observe the existing TDD approach.

## License

MIT
