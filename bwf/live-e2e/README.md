# live-e2e

Live records run the way an app runs them: in Chromium, on the real bwf transport, against a bwf app started with `vite dev`.

The app is small. `routes/live.ts` is a bwf live stream, `routes/call.ts` runs the notes contract from the live package's test fixtures through its registry and publishes each event to the stream, and `client/main.tsx` is what the browser loads: `RecordsProvider`, views on `useLiveQuery`, and the bwf transport.

## Run it

```sh
npm install
npx playwright install chromium   # once
npm test
```

Node 24 is what bwf asks for. The run also works on Node 22 with a warning.

## What it checks

The run counts what the browser opens. It starts the app, puts a small proxy in front of it so it can cut the connection for real, and loads the page through that.

| Check | Fails when |
| --- | --- |
| Three views and sixty views of one note | the counts of streams, subscribe operations or requests differ between them, or a stream opens more than once |
| Thirty views of thirty notes | more than one stream is open at once, the subscribe count isn't one per topic, or a command doesn't come back |
| An event from another window | the record doesn't change, or the window makes a new request to get it |
| An ended subscription the server allows again | the window doesn't ask again, the stream opens again, the window doesn't load again, or an event after it doesn't arrive (twice in a row) |
| An ended subscription the server refuses | the app isn't told, is told more than once, the window asks more than once, or the window changes after the refusal |
| A cut and a restored connection | the window changes while cut off, doesn't open the stream again, doesn't load again, or keeps an older record |

## Not covered

Authentication on the stream, a deployed worker, other browsers, and a slow network. The Thread screen's own browser run covers the app's real module.
