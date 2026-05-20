# TODO: Update README.md
# pi-llama-watch

Pi extension showing LLM status in the status bar: `p[88%]` (amber, prompt processing) and `g[25t/s]` (green, token generation speed).

## Usage

### Automatic

Place the extension in one of these locations:

```
~/.pi/agent/extensions/llama-watch.ts
<path>/pi-llama-watch/src/index.ts  (via settings.json extensions array)
```

### Manual

Load with:

```bash
pi --extension src/index.ts
```

### Commands

```
/llama-watch on       # Enable status display
/llama-watch off      # Disable status display
/llama-watch toggle   # Toggle on/off
```

### Configuration

Set the llama server port:

```bash
export LLAMA_PORT=8080  # default
```

## Display

| State      | Status bar         |
| ---------- | ------------------ |
| Processing | `p[88%]` (amber)   |
| Generating | `g[25t/s]` (green) |
| Idle       | hidden             |

## Status bar colors

- **Processing** (amber/warning): LLM is evaluating the prompt
- **Generating** (green/success): LLM is outputting tokens

## Architecture

```
src/
├── LlamaState.ts       # Core polling class (pure, testable)
├── format.ts           # Pure formatting functions (pure, testable)
├── index.ts            # Pi extension entry point (wires everything together)
├── LlamaState.test.ts  # Tests for LlamaState
└── format.test.ts      # Tests for format functions
```

- `LlamaState` polls `/slots` API every 1s
- `format` functions convert state to display strings
- `index.ts` connects to Pi's `ctx.ui.setStatus()`
