/**
 * @file Dynamic questionnaire engine.
 * @description
 * Renders form fields from questions.json, persists responses in IndexedDB,
 * keeps a draft in localStorage, and supports JSON/JS export for hard copies.
 */

const QUESTIONS_URL = "./questions.json";
const DB_NAME = "dynamicQuestionnaireDB";
const DB_VERSION = 1;
const RESPONSES_STORE = "responses";
const DRAFT_KEY = "dynamicQuestionnaireDraft";
const QUIZ_MODE_KEY = "dynamicQuestionnaireQuizMode";
/** Number of questions displayed per page. */
const PAGE_SIZE = 5;

/**
 * @typedef {"text" | "email" | "number" | "date" | "textarea" | "select" | "radio" | "checkbox"} QuestionType
 */

/**
 * @typedef {Object} Question
 * @property {QuestionType} type - Input type used to render this question.
 * @property {string} name - Field key used in saved payload.
 * @property {string} question - Human-readable label for the prompt.
 * @property {boolean} [required] - If true, field must be answered.
 * @property {string} [placeholder] - Placeholder text for text-like inputs.
 * @property {number} [rows] - Optional textarea rows.
 * @property {number} [min] - Numeric minimum for number fields.
 * @property {number} [max] - Numeric maximum for number fields.
 * @property {number} [step] - Numeric step for number fields.
 * @property {number} [minLength] - Minimum character length for text-like fields.
 * @property {number} [maxLength] - Maximum character length for text-like fields.
 * @property {string} [pattern] - HTML validation pattern for text-like fields.
 * @property {(string|number)[]} [options] - Choice options for select/radio/checkbox.
 * @property {boolean} [emojiStyle] - If true, radio options render as large emoji picker tiles.
 */

/**
 * @typedef {Object} SubmissionRecord
 * @property {number} [id] - Auto-generated IndexedDB identifier.
 * @property {string} createdAt - ISO timestamp of form submission.
 * @property {Record<string, string | string[]>} answers - Serialized answers object.
 */

/** @type {HTMLFormElement} */
const form = document.getElementById("questionnaireForm");
/** @type {HTMLElement} */
const resultsDiv = document.getElementById("results");
/** @type {HTMLElement} */
const progressFill = document.getElementById("progressFill");
/** @type {HTMLElement} */
const progressLabel = document.getElementById("progressLabel");
/** @type {HTMLElement} */
const storageSummary = document.getElementById("storageSummary");
/** @type {HTMLElement} */
const progressBar = document.querySelector(".progress-bar");
/** @type {HTMLElement} */
const responsesTableBody = document.getElementById("responsesTableBody");
/** @type {HTMLElement} */
const storagePanel = document.getElementById("storagePanel");
/** @type {HTMLButtonElement} */
const importResponsesBtn = document.getElementById("importResponsesBtn");
/** @type {HTMLInputElement} */
const importResponsesInput = document.getElementById("importResponsesInput");
/** @type {HTMLInputElement} */
const quizModeToggle = document.getElementById("quizModeToggle");
/** @type {HTMLButtonElement} */
const readAloudBtn = document.getElementById("readAloudBtn");
/** @type {HTMLButtonElement} */
const stopReadAloudBtn = document.getElementById("stopReadAloudBtn");

/** @type {Question[]} */
let questions = [];
/** @type {IDBDatabase | null} */
let db = null;
/** Zero-based index of the currently visible form page. */
let currentPage = 0;
/** Total number of pages derived from questions array length and PAGE_SIZE. */
let totalPages = 0;
/** Tracks whether quiz mode is enabled (admin operations hidden). */
let quizModeEnabled = false;

/**
 * Initializes application state, DOM rendering, persistence setup, and listeners.
 * @returns {Promise<void>}
 */
async function init() {
    try {
        questions = await fetchQuestions();
        validateQuestions(questions);
        renderForm(questions);
        bindUIEvents();
        quizModeEnabled = loadQuizModePreference();
        applyQuizMode(quizModeEnabled);

        db = await openDatabase();
        updateStorageSummary();

        hydrateDraft();
        updateProgress();
    } catch (error) {
        renderFatalError("Unable to initialize questionnaire.", error);
    }
}

/**
 * Fetches question definitions from JSON.
 * @returns {Promise<Question[]>}
 */
async function fetchQuestions() {
    const response = await fetch(QUESTIONS_URL, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Failed to load questions (${response.status})`);
    }

    /** @type {unknown} */
    const payload = await response.json();
    if (!Array.isArray(payload)) {
        throw new Error("questions.json must be an array.");
    }

    return /** @type {Question[]} */ (payload);
}

/**
 * Validates question schema at runtime to fail fast on malformed JSON.
 * @param {Question[]} schema - Question list loaded from JSON.
 * @returns {void}
 */
function validateQuestions(schema) {
    schema.forEach((question, index) => {
        if (!question.name || !question.question || !question.type) {
            throw new Error(`Question at index ${index} is missing required properties.`);
        }

        const optionBased = question.type === "select" || question.type === "radio" || question.type === "checkbox";
        if (optionBased && (!Array.isArray(question.options) || question.options.length === 0)) {
            throw new Error(`Question \"${question.name}\" requires at least one option.`);
        }

        if (question.minLength != null && question.maxLength != null && question.minLength > question.maxLength) {
            throw new Error(`Question \"${question.name}\" has minLength greater than maxLength.`);
        }

        if (question.min != null && question.max != null && question.min > question.max) {
            throw new Error(`Question \"${question.name}\" has min greater than max.`);
        }
    });
}

/**
 * Creates all question UI from schema, split into paginated pages of {@link PAGE_SIZE} questions each.
 * All inputs stay in the DOM at all times — pages are shown/hidden via the `hidden` attribute so that
 * draft hydration, progress tracking, and answer collection work without modification.
 * @param {Question[]} schema - Question list to render.
 * @returns {void}
 */
function renderForm(schema) {
    form.innerHTML = "";

    // Split schema into fixed-size page chunks
    const pages = [];
    for (let i = 0; i < schema.length; i += PAGE_SIZE) {
        pages.push(schema.slice(i, i + PAGE_SIZE));
    }

    totalPages = pages.length;
    currentPage = 0;

    pages.forEach((pageQuestions, pageIndex) => {
        const pageDiv = document.createElement("div");
        pageDiv.className = "question-page";
        pageDiv.dataset.page = String(pageIndex);
        // Only the first page is visible on initial render
        if (pageIndex !== 0) {
            pageDiv.hidden = true;
        }

        // Page counter label shown above the questions
        const pageCounter = document.createElement("p");
        pageCounter.className = "page-counter";
        pageCounter.textContent = `Page ${pageIndex + 1} of ${totalPages}`;
        pageDiv.appendChild(pageCounter);

        pageQuestions.forEach((question, localIndex) => {
            // Global index keeps input IDs stable regardless of which page a question is on
            const globalIndex = pageIndex * PAGE_SIZE + localIndex;

            const group = document.createElement("fieldset");
            group.className = "question-group";

            const label = document.createElement("label");
            label.className = "question-label";
            label.htmlFor = buildInputId(question, globalIndex);
            label.textContent = question.question;

            if (question.required) {
                const requiredBadge = document.createElement("span");
                requiredBadge.className = "required-badge";
                requiredBadge.textContent = "* Required";
                label.append(requiredBadge);
            }

            // Add speak button to each question
            const speakBtn = document.createElement("button");
            speakBtn.type = "button";
            speakBtn.className = "btn btn-speak";
            speakBtn.textContent = "🔊 Speak";
            speakBtn.dataset.questionIndex = String(globalIndex);
            speakBtn.addEventListener("click", (e) => {
                e.preventDefault();
                readQuestionAloud(globalIndex);
            });

            group.append(label, speakBtn, createQuestionInput(question, globalIndex));
            pageDiv.appendChild(group);
        });

        // Navigation row — Back on the left, Next/Submit on the right
        const navGroup = document.createElement("div");
        navGroup.className = "page-nav";

        if (pageIndex > 0) {
            const prevBtn = createButton("← Back", "button", "btn btn-secondary", `prevBtn_${pageIndex}`);
            prevBtn.addEventListener("click", () => goToPage(pageIndex - 1));
            navGroup.appendChild(prevBtn);
        } else {
            // Empty spacer keeps Next right-aligned on the first page
            navGroup.appendChild(document.createElement("span"));
        }

        if (pageIndex < totalPages - 1) {
            const nextBtn = createButton("Next →", "button", "btn btn-primary", `nextBtn_${pageIndex}`);
            nextBtn.addEventListener("click", () => goToPage(pageIndex + 1));
            navGroup.appendChild(nextBtn);
        } else {
            // Last page gets the submit and reset controls
            const lastActions = document.createElement("div");
            lastActions.className = "last-page-actions";

            const submitButton = createButton("Submit Responses", "submit", "btn btn-primary", "submitBtn");
            const resetButton = createButton("Reset Form", "button", "btn btn-ghost", "resetFormBtn");

            resetButton.addEventListener("click", () => {
                form.reset();
                saveDraft();
                updateProgress();
                resultsDiv.hidden = true;
                goToPage(0);
            });

            lastActions.append(submitButton, resetButton);
            navGroup.appendChild(lastActions);
        }

        pageDiv.appendChild(navGroup);
        form.appendChild(pageDiv);
    });
}

/**
 * Shows the target page and hides all others, then scrolls to the top of the card.
 * @param {number} pageIndex - Zero-based target page number.
 * @returns {void}
 */
function goToPage(pageIndex) {
    stopReadingAloud();
    form.querySelectorAll(".question-page").forEach((page) => {
        /** @type {HTMLElement} */ (page).hidden = page.dataset.page !== String(pageIndex);
    });
    currentPage = pageIndex;
    updateProgress();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Builds DOM controls based on a question type.
 * @param {Question} question - Question object from schema.
 * @param {number} index - Zero-based index in schema array.
 * @returns {HTMLElement}
 */
function createQuestionInput(question, index) {
    if (question.type === "textarea") {
        const textarea = document.createElement("textarea");
        textarea.name = question.name;
        textarea.id = buildInputId(question, index);
        textarea.rows = Number.isFinite(question.rows) ? Number(question.rows) : 4;
        textarea.required = Boolean(question.required);
        textarea.placeholder = question.placeholder || "";
        applySharedValidationAttributes(textarea, question);
        return textarea;
    }

    if (question.type === "select") {
        const select = document.createElement("select");
        select.name = question.name;
        select.id = buildInputId(question, index);
        select.required = Boolean(question.required);

        if (!question.required) {
            const defaultOption = document.createElement("option");
            defaultOption.value = "";
            defaultOption.textContent = "Select one";
            select.appendChild(defaultOption);
        }

        question.options.forEach((optionValue) => {
            const option = document.createElement("option");
            option.value = String(optionValue);
            option.textContent = String(optionValue);
            select.appendChild(option);
        });

        return select;
    }

    if (question.type === "radio" || question.type === "checkbox") {
        const optionsWrap = document.createElement("div");
        // Emoji-style grid layout for feeling questions; standard list for all others
        optionsWrap.className = question.emojiStyle ? "option-list option-list--emoji" : "option-list";

        question.options.forEach((optionValue, optionIndex) => {
            const optionLabel = document.createElement("label");
            optionLabel.className = question.emojiStyle ? "option-item option-item--emoji" : "option-item";

            const input = document.createElement("input");
            input.type = question.type;
            input.name = question.name;
            input.value = String(optionValue);
            input.id = `${buildInputId(question, index)}_${optionIndex}`;

            if (question.required && question.type === "radio") {
                input.required = true;
            }

            if (question.emojiStyle) {
                // Split "😊 Happy" into the leading emoji and the label text
                const str = String(optionValue);
                const firstSpace = str.indexOf(" ");
                const emojiIcon = firstSpace > 0 ? str.slice(0, firstSpace) : str;
                const labelText = firstSpace > 0 ? str.slice(firstSpace + 1) : "";

                const iconSpan = document.createElement("span");
                iconSpan.className = "emoji-icon";
                iconSpan.setAttribute("aria-hidden", "true");
                iconSpan.textContent = emojiIcon;

                const textSpan = document.createElement("span");
                textSpan.className = "emoji-label";
                textSpan.textContent = labelText;

                optionLabel.append(input, iconSpan, textSpan);
            } else {
                optionLabel.append(input, document.createTextNode(String(optionValue)));
            }

            optionsWrap.appendChild(optionLabel);
        });

        return optionsWrap;
    }

    const input = document.createElement("input");
    input.type = question.type;
    input.name = question.name;
    input.id = buildInputId(question, index);
    input.required = Boolean(question.required);
    input.placeholder = question.placeholder || "";
    applySharedValidationAttributes(input, question);

    if (question.type === "number") {
        if (question.min != null) {
            input.min = String(question.min);
        }
        if (question.max != null) {
            input.max = String(question.max);
        }
        if (question.step != null) {
            input.step = String(question.step);
        }
    }

    return input;
}

/**
 * Applies reusable validation attributes for text-like controls.
 * @param {HTMLInputElement | HTMLTextAreaElement} input - Form control to decorate.
 * @param {Question} question - Source question schema.
 * @returns {void}
 */
function applySharedValidationAttributes(input, question) {
    if (question.minLength != null) {
        input.minLength = question.minLength;
    }

    if (question.maxLength != null) {
        input.maxLength = question.maxLength;
    }

    if (question.pattern && input instanceof HTMLInputElement && question.type !== "number") {
        input.pattern = question.pattern;
    }
}

/**
 * Generates a stable DOM id for a question input.
 * @param {Question} question - Question object.
 * @param {number} index - Numeric position in list.
 * @returns {string}
 */
function buildInputId(question, index) {
    return `question_${index}_${question.name}`;
}

/**
 * Creates a button element with common attributes.
 * @param {string} text - Button text.
 * @param {"button" | "submit" | "reset"} type - Native button type.
 * @param {string} className - CSS class list.
 * @param {string} id - DOM id.
 * @returns {HTMLButtonElement}
 */
function createButton(text, type, className, id) {
    const button = document.createElement("button");
    button.type = type;
    button.className = className;
    button.id = id;
    button.textContent = text;
    return button;
}

/**
 * Adds event listeners for form interactions and control actions.
 * @returns {void}
 */
function bindUIEvents() {
    form.addEventListener("submit", onSubmit);
    form.addEventListener("change", onDraftRelevantChange);
    form.addEventListener("input", onDraftRelevantChange);

    document.getElementById("saveDraftBtn").addEventListener("click", () => {
        saveDraft();
        showNotice("Draft saved locally.");
    });

    document.getElementById("clearDraftBtn").addEventListener("click", () => {
        localStorage.removeItem(DRAFT_KEY);
        form.reset();
        updateProgress();
        showNotice("Draft cleared.");
    });

    document.getElementById("exportLatestBtn").addEventListener("click", exportLatestSubmission);
    document.getElementById("exportAllBtn").addEventListener("click", exportAllSubmissionsJson);
    document.getElementById("exportAllJsBtn").addEventListener("click", exportAllSubmissionsJs);
    importResponsesBtn.addEventListener("click", () => importResponsesInput.click());
    importResponsesInput.addEventListener("change", onImportFileSelected);
    quizModeToggle.addEventListener("change", () => {
        applyQuizMode(quizModeToggle.checked);
    });
    readAloudBtn.addEventListener("click", readCurrentPageAloud);
    stopReadAloudBtn.addEventListener("click", stopReadingAloud);
    stopReadAloudBtn.disabled = true;

    document.getElementById("clearResponsesBtn").addEventListener("click", async () => {
        if (!confirm("Delete all saved responses from browser storage?")) {
            return;
        }

        await clearAllResponses();
        updateStorageSummary();
        showNotice("Saved response history cleared.");
    });
}

/**
 * Handles draft-relevant input changes.
 * @returns {void}
 */
function onDraftRelevantChange() {
    saveDraft();
    updateProgress();
}

/**
 * Serializes all form controls into a typed answers object.
 * @returns {Record<string, string | string[]>}
 */
function collectAnswers() {
    /** @type {Record<string, string | string[]>} */
    const answers = {};

    questions.forEach((question) => {
        if (question.type === "checkbox") {
            const selectedValues = Array.from(
                form.querySelectorAll(`input[name="${question.name}"]:checked`),
                (el) => /** @type {HTMLInputElement} */ (el).value
            );
            answers[question.name] = selectedValues;
            return;
        }

        if (question.type === "radio") {
            const selected = /** @type {HTMLInputElement | null} */ (
                form.querySelector(`input[name="${question.name}"]:checked`)
            );
            answers[question.name] = selected ? selected.value : "";
            return;
        }

        const control = /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null} */ (
            form.elements.namedItem(question.name)
        );

        answers[question.name] = control ? control.value : "";
    });

    return answers;
}

/**
 * Form submission handler: validates, persists, renders summary, and resets draft.
 * @param {SubmitEvent} event - Form submit event.
 * @returns {Promise<void>}
 */
async function onSubmit(event) {
    event.preventDefault();

    if (!form.reportValidity()) {
        return;
    }

    const answers = collectAnswers();

    /** @type {SubmissionRecord} */
    const payload = {
        createdAt: new Date().toISOString(),
        answers
    };

    await saveSubmission(payload);
    localStorage.removeItem(DRAFT_KEY);

    renderResults(payload);
    form.reset();
    updateProgress();
    goToPage(0);
    await updateStorageSummary();
}

/**
 * Renders a success panel with latest response values.
 * @param {SubmissionRecord} submission - Persisted submission payload.
 * @returns {void}
 */
function renderResults(submission) {
    if (quizModeEnabled) {
        resultsDiv.innerHTML = `
            <h2>Submission Saved</h2>
            <p>Thanks. Your answers were recorded successfully.</p>
        `;
        resultsDiv.hidden = false;
        return;
    }

    const listItems = Object.entries(submission.answers)
        .map(([key, value]) => {
            const printable = Array.isArray(value) ? value.join(", ") || "(none)" : value || "(empty)";
            return `<li><strong>${escapeHtml(key)}:</strong> ${escapeHtml(printable)}</li>`;
        })
        .join("");

    resultsDiv.innerHTML = `
        <h2>Latest Submission</h2>
        <p><strong>Saved At:</strong> ${new Date(submission.createdAt).toLocaleString()}</p>
        <ul class="results-list">${listItems}</ul>
    `;
    resultsDiv.hidden = false;
}

/**
 * Updates completion progress based on answered question count.
 * @returns {void}
 */
function updateProgress() {
    const answeredCount = questions.reduce((count, question) => {
        const value = getQuestionAnswerState(question);
        return count + (value ? 1 : 0);
    }, 0);

    const total = questions.length || 1;
    const percent = Math.round((answeredCount / total) * 100);

    progressFill.style.width = `${percent}%`;
    progressLabel.textContent = `${percent}% Complete`;
    progressBar.setAttribute("aria-valuenow", String(percent));
}

/**
 * Returns whether a question currently has a meaningful answer.
 * @param {Question} question - Question definition.
 * @returns {boolean}
 */
function getQuestionAnswerState(question) {
    if (question.type === "checkbox") {
        return form.querySelectorAll(`input[name="${question.name}"]:checked`).length > 0;
    }

    if (question.type === "radio") {
        return Boolean(form.querySelector(`input[name="${question.name}"]:checked`));
    }

    const control = /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null} */ (
        form.elements.namedItem(question.name)
    );

    return Boolean(control && String(control.value).trim());
}

/**
 * Persists current form values to localStorage as a draft object.
 * @returns {void}
 */
function saveDraft() {
    const draft = {
        savedAt: new Date().toISOString(),
        answers: collectAnswers()
    };

    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

/**
 * Restores draft answers from localStorage into rendered controls.
 * @returns {void}
 */
function hydrateDraft() {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) {
        return;
    }

    try {
        /** @type {{ savedAt: string, answers: Record<string, string | string[]> }} */
        const draft = JSON.parse(raw);

        questions.forEach((question) => {
            const value = draft.answers[question.name];
            if (value == null) {
                return;
            }

            if (question.type === "checkbox") {
                const selectedValues = Array.isArray(value) ? value : [];
                form.querySelectorAll(`input[name="${question.name}"]`).forEach((node) => {
                    const input = /** @type {HTMLInputElement} */ (node);
                    input.checked = selectedValues.includes(input.value);
                });
                return;
            }

            if (question.type === "radio") {
                form.querySelectorAll(`input[name="${question.name}"]`).forEach((node) => {
                    const input = /** @type {HTMLInputElement} */ (node);
                    input.checked = input.value === value;
                });
                return;
            }

            const control = /** @type {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null} */ (
                form.elements.namedItem(question.name)
            );
            if (control) {
                control.value = Array.isArray(value) ? "" : String(value);
            }
        });

        showNotice(`Draft restored from ${new Date(draft.savedAt).toLocaleString()}.`);
    } catch {
        localStorage.removeItem(DRAFT_KEY);
    }
}

/**
 * Opens IndexedDB and ensures response object store exists.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(RESPONSES_STORE)) {
                const store = database.createObjectStore(RESPONSES_STORE, {
                    keyPath: "id",
                    autoIncrement: true
                });
                store.createIndex("createdAt", "createdAt", { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
    });
}

/**
 * Saves a submission record into IndexedDB.
 * @param {SubmissionRecord} submission - Payload to persist.
 * @returns {Promise<number>} Inserted record id.
 */
function saveSubmission(submission) {
    if (!db) {
        return Promise.reject(new Error("Database is not available."));
    }

    return new Promise((resolve, reject) => {
        const tx = db.transaction(RESPONSES_STORE, "readwrite");
        const store = tx.objectStore(RESPONSES_STORE);
        const request = store.add(submission);

        request.onsuccess = () => resolve(Number(request.result));
        request.onerror = () => reject(request.error || new Error("Failed to save submission."));
    });
}

/**
 * Fetches all saved submissions, sorted descending by timestamp.
 * @returns {Promise<SubmissionRecord[]>}
 */
function getAllSubmissions() {
    if (!db) {
        return Promise.resolve([]);
    }

    return new Promise((resolve, reject) => {
        const tx = db.transaction(RESPONSES_STORE, "readonly");
        const store = tx.objectStore(RESPONSES_STORE);
        const request = store.getAll();

        request.onsuccess = () => {
            const rows = /** @type {SubmissionRecord[]} */ (request.result || []);
            rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            resolve(rows);
        };
        request.onerror = () => reject(request.error || new Error("Failed to read submissions."));
    });
}

/**
 * Deletes all stored submissions from IndexedDB.
 * @returns {Promise<void>}
 */
function clearAllResponses() {
    if (!db) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const tx = db.transaction(RESPONSES_STORE, "readwrite");
        const store = tx.objectStore(RESPONSES_STORE);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error("Failed to clear submissions."));
    });
}

/**
 * Updates storage metadata panel with current save count.
 * @returns {Promise<void>}
 */
async function updateStorageSummary() {
    const submissions = await getAllSubmissions();
    if (submissions.length === 0) {
        storageSummary.textContent = "No submissions stored yet.";
        renderSubmissionsTable(submissions);
        return;
    }

    const latest = submissions[0];
    storageSummary.textContent = `${submissions.length} submission(s) saved. Latest: ${new Date(latest.createdAt).toLocaleString()}.`;
    renderSubmissionsTable(submissions);
}

/**
 * Renders the saved submission list in a table for admin review.
 * @param {SubmissionRecord[]} submissions - Persisted submission records.
 * @returns {void}
 */
function renderSubmissionsTable(submissions) {
    if (submissions.length === 0) {
        responsesTableBody.innerHTML = "<tr><td colspan=\"4\">No submissions yet.</td></tr>";
        return;
    }

    const rows = submissions
        .map((submission) => {
            const preview = Object.entries(submission.answers)
                .slice(0, 2)
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
                .join(" | ");

            return `
                <tr>
                    <td>${submission.id ?? "-"}</td>
                    <td>${escapeHtml(new Date(submission.createdAt).toLocaleString())}</td>
                    <td>${getAnsweredFieldCount(submission.answers)}</td>
                    <td class="preview-text">${escapeHtml(preview || "(no values)")}</td>
                </tr>
            `;
        })
        .join("");

    responsesTableBody.innerHTML = rows;
}

/**
 * Counts non-empty answers in a submission payload.
 * @param {Record<string, string | string[]>} answers - Serialized answer map.
 * @returns {number}
 */
function getAnsweredFieldCount(answers) {
    return Object.values(answers).reduce((count, value) => {
        if (Array.isArray(value)) {
            return count + (value.length > 0 ? 1 : 0);
        }

        return count + (String(value).trim() ? 1 : 0);
    }, 0);
}

/**
 * Handles file selection for importing response archives.
 * @param {Event} event - Input change event.
 * @returns {Promise<void>}
 */
async function onImportFileSelected(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0];
    input.value = "";

    if (!file) {
        return;
    }

    const text = await file.text();

    try {
        /** @type {unknown} */
        const parsed = JSON.parse(text);
        const normalized = normalizeImportedSubmissions(parsed);

        if (normalized.length === 0) {
            showNotice("Import file is valid but contains no submissions.");
            return;
        }

        await saveManySubmissions(normalized);
        await updateStorageSummary();
        showNotice(`Imported ${normalized.length} submission(s) from file.`);
    } catch (error) {
        showNotice("Import failed. Ensure the file is valid JSON exported by this app.");
        console.error(error);
    }
}

/**
 * Normalizes supported import payload shapes into submission records.
 * @param {unknown} payload - Parsed JSON payload.
 * @returns {SubmissionRecord[]}
 */
function normalizeImportedSubmissions(payload) {
    if (Array.isArray(payload)) {
        return payload.map(toSubmissionRecord).filter(Boolean);
    }

    if (isObject(payload) && Array.isArray(payload.submissions)) {
        return payload.submissions.map(toSubmissionRecord).filter(Boolean);
    }

    const single = toSubmissionRecord(payload);
    return single ? [single] : [];
}

/**
 * Converts unknown input into a sanitized submission record.
 * @param {unknown} row - Potential submission payload.
 * @returns {SubmissionRecord | null}
 */
function toSubmissionRecord(row) {
    if (!isObject(row) || !isObject(row.answers)) {
        return null;
    }

    /** @type {Record<string, string | string[]>} */
    const cleanAnswers = {};
    Object.entries(row.answers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            cleanAnswers[key] = value.map((item) => String(item));
            return;
        }

        cleanAnswers[key] = value == null ? "" : String(value);
    });

    return {
        createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
        answers: cleanAnswers
    };
}

/**
 * Writes many submission records into IndexedDB in a single transaction.
 * @param {SubmissionRecord[]} records - Records to persist.
 * @returns {Promise<void>}
 */
function saveManySubmissions(records) {
    if (!db || records.length === 0) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const tx = db.transaction(RESPONSES_STORE, "readwrite");
        const store = tx.objectStore(RESPONSES_STORE);

        records.forEach((record) => {
            store.add(record);
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("Failed to import submissions."));
        tx.onabort = () => reject(tx.error || new Error("Submission import aborted."));
    });
}

/**
 * Determines whether a value is a non-null plain object.
 * @param {unknown} value - Unknown runtime value.
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return typeof value === "object" && value !== null;
}

/**
 * Exports the latest saved submission as a JSON file download.
 * @returns {Promise<void>}
 */
async function exportLatestSubmission() {
    const submissions = await getAllSubmissions();
    if (submissions.length === 0) {
        showNotice("No saved submissions to export.");
        return;
    }

    const latest = submissions[0];
    const fileName = `latest-response-${timestampForFile()}.json`;
    downloadFile(fileName, JSON.stringify(latest, null, 2), "application/json");
}

/**
 * Exports all saved submissions as a JSON file download.
 * @returns {Promise<void>}
 */
async function exportAllSubmissionsJson() {
    const submissions = await getAllSubmissions();
    if (submissions.length === 0) {
        showNotice("No saved submissions to export.");
        return;
    }

    const payload = {
        exportedAt: new Date().toISOString(),
        total: submissions.length,
        submissions
    };

    const fileName = `all-responses-${timestampForFile()}.json`;
    downloadFile(fileName, JSON.stringify(payload, null, 2), "application/json");
}

/**
 * Exports all submissions as a JavaScript module file for code-based archiving.
 * @returns {Promise<void>}
 */
async function exportAllSubmissionsJs() {
    const submissions = await getAllSubmissions();
    if (submissions.length === 0) {
        showNotice("No saved submissions to export.");
        return;
    }

    const modulePayload = `export const questionnaireResponses = ${JSON.stringify(submissions, null, 2)};\n`;
    const fileName = `all-responses-${timestampForFile()}.js`;
    downloadFile(fileName, modulePayload, "text/javascript");
}

/**
 * Triggers browser download for serialized content.
 * @param {string} fileName - Name of the generated file.
 * @param {string} content - File content.
 * @param {string} mimeType - MIME type of generated file.
 * @returns {void}
 */
function downloadFile(fileName, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Produces a filesystem-safe timestamp for exported filenames.
 * @returns {string}
 */
function timestampForFile() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Renders non-fatal status text in results panel.
 * @param {string} message - Message to display.
 * @returns {void}
 */
function showNotice(message) {
    resultsDiv.innerHTML = `<h2>Status</h2><p>${escapeHtml(message)}</p>`;
    resultsDiv.hidden = false;
}

/**
 * Applies quiz mode visibility rules and stores preference.
 * Quiz mode hides IndexedDB administration operations for child-friendly sessions.
 * @param {boolean} enabled - Whether quiz mode should be active.
 * @returns {void}
 */
function applyQuizMode(enabled) {
    quizModeEnabled = Boolean(enabled);
    quizModeToggle.checked = quizModeEnabled;
    storagePanel.hidden = quizModeEnabled;
    document.body.classList.toggle("quiz-mode", quizModeEnabled);
    localStorage.setItem(QUIZ_MODE_KEY, quizModeEnabled ? "1" : "0");
}

/**
 * Loads quiz mode preference from local storage.
 * @returns {boolean}
 */
function loadQuizModePreference() {
    return localStorage.getItem(QUIZ_MODE_KEY) === "1";
}

/**
 * Reads the currently visible page questions and options aloud via Web Speech API.
 * @returns {void}
 */
function readCurrentPageAloud() {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        showNotice("Read aloud is not supported in this browser.");
        return;
    }

    // Find the first unanswered question on this page
    const startIndex = currentPage * PAGE_SIZE;
    const pageQuestions = questions.slice(startIndex, startIndex + PAGE_SIZE);
    
    let firstUnansweredIndex = -1;
    for (let i = 0; i < pageQuestions.length; i++) {
        const globalIndex = startIndex + i;
        const input = getInputElement(pageQuestions[i], globalIndex);
        if (input && !getInputValue(input)) {
            firstUnansweredIndex = globalIndex;
            break;
        }
    }

    if (firstUnansweredIndex === -1 && pageQuestions.length > 0) {
        // All answered, read the first one
        firstUnansweredIndex = startIndex;
    }

    if (firstUnansweredIndex === -1) {
        showNotice("There are no questions to read on this page.");
        return;
    }

    readQuestionAloud(firstUnansweredIndex);
}

/**
 * Reads a specific question aloud by its global index.
 * @param {number} questionIndex - Global index of the question to read.
 * @returns {void}
 */
function readQuestionAloud(questionIndex) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        showNotice("Read aloud is not supported in this browser.");
        return;
    }

    if (questionIndex < 0 || questionIndex >= questions.length) {
        showNotice("Question not found.");
        return;
    }

    const question = questions[questionIndex];
    const speechText = buildSpeechTextForQuestion(question);
    
    if (!speechText) {
        showNotice("Unable to read this question.");
        return;
    }

    stopReadingAloud();

    const utterance = new SpeechSynthesisUtterance(speechText);
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.lang = "en-US";

    utterance.onstart = () => {
        readAloudBtn.disabled = true;
        stopReadAloudBtn.disabled = false;
        showNotice("Reading this question aloud now.");
    };

    utterance.onend = () => {
        readAloudBtn.disabled = false;
        stopReadAloudBtn.disabled = true;
        showNotice("Tap Next to go to the next question or click Speak to hear this one again.");
    };

    utterance.onerror = () => {
        readAloudBtn.disabled = false;
        stopReadAloudBtn.disabled = true;
        showNotice("Read aloud failed. Try again in this browser.");
    };

    window.speechSynthesis.speak(utterance);
}

/**
 * Stops active speech playback if one is running.
 * @returns {void}
 */
function stopReadingAloud() {
    if (!("speechSynthesis" in window)) {
        return;
    }

    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
    }

    readAloudBtn.disabled = false;
    stopReadAloudBtn.disabled = true;
}

/**
 * Builds natural-language speech text for a single question.
 * @param {Question} question - Question object to read.
 * @returns {string}
 */
function buildSpeechTextForQuestion(question) {
    let line = `${question.question}`;
    
    if (Array.isArray(question.options) && question.options.length > 0) {
        const options = question.options
            .map((option) => String(option).replace(/^[^\w\s]+\s*/, ""))
            .join(", ");
        line += ` Choices are: ${options}.`;
    }

    return line;
}

/**
 * Gets the input element for a question by name.
 * @param {Question} question - Question object.
 * @param {number} index - Global question index.
 * @returns {HTMLElement | null}
 */
function getInputElement(question, index) {
    return document.getElementById(buildInputId(question, index));
}

/**
 * Gets the current value from an input element.
 * @param {HTMLElement} input - Input element.
 * @returns {string | string[]}
 */
function getInputValue(input) {
    if (input instanceof HTMLInputElement) {
        if (input.type === "checkbox") {
            return input.checked ? input.value : "";
        }
        if (input.type === "radio") {
            return input.checked ? input.value : "";
        }
        return input.value;
    }
    
    if (input instanceof HTMLTextAreaElement) {
        return input.value;
    }
    
    if (input instanceof HTMLSelectElement) {
        return input.value;
    }

    return "";
}

/**
 * Renders a fatal startup error and logs root cause to console.
 * @param {string} message - User-facing message.
 * @param {unknown} error - Original error object.
 * @returns {void}
 */
function renderFatalError(message, error) {
    console.error(error);
    resultsDiv.innerHTML = `<h2>Application Error</h2><p>${escapeHtml(message)}</p>`;
    resultsDiv.hidden = false;
}

/**
 * Escapes text for safe insertion into HTML templates.
 * @param {string} value - Raw text.
 * @returns {string}
 */
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

init();
