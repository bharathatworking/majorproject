/**
 * The "example user test plan" PDF from the Chrome runs, as pdf.js gives it
 * (lib/input/pdf.ts: a newline at each line end, wrapped lines, list markers
 * at line starts, no blank lines). Page 1 in full and the start of page 2,
 * so a sentence crosses the page break. Used by the splitting tests.
 */

/** Page texts, as createDocumentFromPDF collects them. */
export const TEST_PLAN_PDF_PAGES: readonly string[] = [
  [
    "User Test Plan Example",
    "Situating Context:   You are consulting for a startup that has created an online calendar system",
    "(named, TeamCal) for managers in small businesses or teams. You would like to conduct a study to",
    "be able to identify usability issues, get general feedback, and also demonstrate that your system",
    "works well for key tasks like finding common meeting times and scheduling work hours. Draft a",
    "use study plan to accomplish these goals, including a focused statement of the objectives, users,",
    "setting, methods, tasks, metrics, and researcher roles. ",
    "Objectives: ",
    "1.   Formative: identify common usability issues with TeamCal.",
    "2.   Summative: compare TeamCal to Google Calendar based on user performance and",
    "preference on two common tasks—finding a common meeting time and scheduling work",
    "hours on specific projects.",
    "3.   Formative: gather feedback as to the potential usefulness of TeamCal. ",
    "Users:   20 managers who currently manage a business or team that includes coordinating between",
    "5 and 50 workers. The managers should cover diverse types of businesses and diverse",
    "demographics. All managers should already be familiar with Google Calendar. A professional",
    "recruiting firm contracted by your company will recruit all participants. ",
    "Setting:   The study will be conducted at a usability lab, equipped with an observation room and a",
    "desktop computer. The browser will point to a calendar with sample data and schedules",
    "preloaded into the system. ",
    "Researcher Roles:   One researcher (Researcher A) will greet participants, gather consent,",
    "familiarize with the scenario, answer any questions, and carry out the post-task interview.",
    "Researcher A will also be responsible for intervening with the user if they explicitly ask for help or",
    "if they are stuck on a task for more than 10 minutes. Another researcher (Researcher B) will",
    "observe and take notes throughout the study and reset all of the equipment for the next",
    "participant. ",
    "Methods:   The overall study will take 75 minutes on average (though participants will be asked to",
    "reserve a 90 minute time, just in case), with the following sequence of tasks and approximate",
    "breakdown of times: ",
    "•   Researcher A will greet the participants, gather consent, describe the goals of the study, and",
    "give brief overviews of the employee address book (~10 minutes). ",
    "•   Each participant will do two think-aloud tasks with TeamCal (see below for tasks), during",
    "which time Researcher B will note usability issues and other unstructured observations as",
    "they arise (~20 minutes). ",
    "•   Each participant will do a scheduling hours task and a common meeting time task in each of",
    "the technologies (Google Calendar or TeamCal) in counterbalanced order (see tasks below).",
    "Researcher B will time the task takes and note any errors or backtracking that occurs along the",
    "way. After completing all summative tasks, Researcher A will ask the participants which ",
  ].join('\n'),
  [
    "system (Google Calendar or TeamCal) they prefer for each task: scheduling hours and for",
    "finding common meeting times (~30 minutes total). ",
    "•   Researcher A (while Researcher B takes notes) will ask the participant general feedback on",
    "TeamCal (~10 minutes), including: ",
    "o   What is your overall perception of TeamCal? ",
    "o   How could TeamCal be useful in your workplace? ",
    "o   What are some things that you would change about TeamCal to make it more useful? ",
    "o   Any other feedback for us? ",
    "•   Finally, Researcher A will thank the participants for their time and compensate them with a",
    "$50 gift card (~5 minutes). ",
    "Metrics: ",
    "1.   Think-aloud usability tasks:",
  ].join('\n'),
];

/** The same text pasted from a PDF viewer: one string, lines kept. */
export const TEST_PLAN_PASTE = TEST_PLAN_PDF_PAGES.join('\n');

/** The same text flattened, as the old PDF import stored it (one line). */
export const TEST_PLAN_FLAT = TEST_PLAN_PDF_PAGES.map(p => p.replace(/\s+/g, ' ').trim()).join(' ');
