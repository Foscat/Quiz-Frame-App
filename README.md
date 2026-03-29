# Dynamic Questionnaire

A fully client-side questionnaire engine built with Vanilla JavaScript. Questions are defined in `questions.json`, responses are persisted in the browser with IndexedDB, and hard copies can be exported as `.json` or `.js` files.

---

## ⚠️ Why You See 0 Questions When You Open It Directly

Double-clicking `index.html` to open it in your browser will show **0 questions and a blank form**. This is expected behavior — not a bug.

**Why it happens:**  
The app uses `<script type="module">` and fetches `questions.json` via the `fetch()` API. Browsers enforce a security rule called **CORS (Cross-Origin Resource Sharing)** that blocks `fetch()` calls when a page is loaded from the local file system (`file://`). There is no workaround for this — you must serve the files over HTTP.

**Fix: Run a local web server.** Pick any one of the three options below.

---

## How to Run the App

### Option 1 — VS Code Live Server (Easiest)

1. Open the `questions` folder in VS Code.
2. Install the **Live Server** extension by Ritwick Dey (search `ritwickdey.liveserver` in the Extensions panel).
3. Right-click `index.html` in the Explorer panel and select **"Open with Live Server"**.
4. Your browser opens at `http://127.0.0.1:5500` and the questions load automatically.
5. Any time you save a file, the browser refreshes instantly.

### Option 2 — Python (No install needed on most machines)

Open a terminal in the `questions` folder and run:

```bash
# Python 3
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

### Option 3 — Node.js `http-server`

```bash
npx http-server . -p 8080
```

Then open `http://localhost:8080` in your browser.

---

## How to Use the App

1. **Open the app** using one of the server methods above.
2. **Answer each question.** The progress bar at the top updates as you fill in fields.
3. **Submit the form** using the "Submit" button at the bottom.
4. **View your results** — a formatted summary appears below the form immediately after submission.
5. **Export your responses** using the buttons in the "Saved Responses" panel:
   - **Export Latest (.json)** — downloads only your most recent submission.
   - **Export All (.json)** — downloads every submission as a JSON array.
   - **Export All (.js)** — same data formatted as an ES module (`export default [...]`).
6. **Import responses** — use "Import Responses (.json)" to load a previously exported file back into the app.
7. **Save Draft** — saves your in-progress answers to `localStorage` so you can resume later without submitting.
8. **Clear Draft** — wipes the current in-progress draft.
9. **Clear Saved Responses** — removes all submissions from IndexedDB permanently.

---

## How Responses Are Saved

| Storage | What is saved | When it clears |
|---|---|---|
| **IndexedDB** | Every submitted response, with a timestamp | Only when you click "Clear Saved Responses" or clear site data in the browser |
| **localStorage** | In-progress draft (unsubmitted answers) | When you click "Clear Draft" or submit the form |
| **Exported file** | Hard copy on your disk | Never — you keep the file |

IndexedDB data is stored per browser and per domain. If you switch browsers or serve on a different port, the history will be empty.

---

## Customizing Questions

Edit `questions.json` to add, remove, or change questions. Each question is an object in the array.

### Supported Question Types

| `type` | Renders as | Supports `options`? |
|---|---|---|
| `text` | Single-line text input | No |
| `email` | Email text input | No |
| `number` | Number spinner | No |
| `textarea` | Multi-line text area | No |
| `select` | Dropdown menu | Yes |
| `radio` | Radio button group | Yes |
| `checkbox` | Checkbox group | Yes |

### Question Schema

```json
{
    "type": "radio",
    "question": "The label shown to the user",
    "name": "uniqueFieldKey",
    "required": true,
    "options": ["Option A", "Option B", "Option C"]
}
```

**All fields:**

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | Input type (see table above) |
| `question` | string | Yes | Label text displayed above the field |
| `name` | string | Yes | Unique key used in the saved response object |
| `required` | boolean | No | If `true`, user must answer before submitting |
| `placeholder` | string | No | Placeholder text for text/number/textarea inputs |
| `options` | string[] | For select/radio/checkbox | List of choices |
| `rows` | number | No | Number of rows for `textarea` |
| `min` / `max` | number | No | Min/max value for `number` fields |
| `minLength` / `maxLength` | number | No | Character limits for text-like fields |

---

## Project Files

| File | Purpose |
|---|---|
| `index.html` | App shell — layout, buttons, and the form container |
| `main.js` | All application logic — rendering, IndexedDB, export, import |
| `questions.json` | Question definitions — edit this to change the survey |
| `styles.css` | All visual styling |

---

## Generating API Docs with jsdoc2md

The code in `main.js` is annotated with JSDoc comments compatible with [jsdoc-to-markdown](https://github.com/jsdoc2md/jsdoc-to-markdown).

```bash
npx jsdoc-to-markdown main.js > API.md
```
