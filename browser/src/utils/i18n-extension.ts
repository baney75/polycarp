import { setTranslations } from "@mariozechner/mini-lit";
import { translations as webUiTranslations } from "@mariozechner/pi-web-ui";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages {
		// Web-UI base keys (needed for type safety)
		"Delete this session?": string;
		Today: string;
		Yesterday: string;
		"{days} days ago": string;
		Sessions: string;
		"Load a previous conversation": string;
		"No sessions yet": string;
		messages: string;
		Delete: string;
		"Loading...": string;
		"Error loading document": string;
		"Error loading spreadsheet": string;
		"Failed to load spreadsheet": string;
		"Preview not available for this file type.": string;
		"Click the download button above to view it on your computer.": string;
		Settings: string;

		// Tabkyra extension keys
		// Custom provider dialog
		"A custom provider with that name already exists": string;
		"API Key (optional)": string;
		"API Type": string;
		"Add Custom Provider": string;
		"Add Model": string;
		"Add at least one model": string;
		"Base URL": string;
		"Context window": string;
		"Defaults to model ID": string;
		"Display Name (optional)": string;
		"Edit Custom Provider": string;
		"Failed to save provider": string;
		"Leave empty if the endpoint needs no key": string;
		"Max output tokens": string;
		"Model ID": string;
		"Model IDs must be unique": string;
		Models: string;
		"OpenAI-compatible base \u2014 usually ends in /v1.": string;
		"Please enter a base URL": string;
		"Please enter a provider name": string;
		"Provider Name": string;
		"Provider saved": string;
		Reasoning: string;
		Remove: string;
		"Root URL \u2014 the client appends /v1/messages.": string;
		Save: string;
		"That name is reserved by a built-in provider. Choose a different name.": string;
		Vision: string;
		"e.g. OpenRouter, Together, My Server": string;
		"Permission request failed": string;
		"JavaScript Execution Permission Required": string;
		"This extension needs permission to execute JavaScript code on web pages": string;
		"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.": string;
		"The AI can read and modify web page content when you ask it to": string;
		"Code runs in an isolated environment with security safeguards": string;
		"Network access is blocked to prevent data exfiltration": string;
		"You can revoke this permission at any time in browser settings": string;
		"Writing JavaScript code...": string;
		"Execute JavaScript": string;
		"Preparing JavaScript...": string;
		"Getting skill": string;
		"Got skill": string;
		"Listing skills": string;
		"Creating skill": string;
		"Created skill": string;
		"Updating skill": string;
		"Updated skill": string;
		"Rewriting skill": string;
		"Rewritten skill": string;
		"Deleting skill": string;
		"Processing skill...": string;
		"No skills found": string;
		"Skills for domain": string;
		"Deleted skill": string;
		Examples: string;
		Library: string;
		"Command failed:": string;
		"Why is this needed?": string;
		"What this means:": string;
		"Continue Anyway": string;
		"Requesting...": string;
		"Grant Permission": string;
		"Navigating to": string;
		"Click to open": string;
		"Waiting...": string;
		Current: string;
		Locked: string;
		"Export failed. Check console for details.": string;
		"Invalid import file format": string;
		"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.": string;
		"Imported {imported} sessions, skipped {skipped} duplicates": string;
		"Imported {count} sessions": string;
		"Import failed. Check console for details.": string;
		Import: string;
		"Export All": string;
		Export: string;
		"No sessions older than {days} days": string;
		"Delete {count} sessions older than {days} days?": string;
		"Failed to delete sessions. Check console for details.": string;
		"Delete Old": string;
		"All sessions": string;
		"No sessions to delete": string;
		"Delete ALL {count} sessions? This cannot be undone!": string;
		"Older than 7 days": string;
		"Older than 30 days": string;
		"Older than 90 days": string;
		"Search sessions...": string;
		"Total: {count} sessions · {messages} messages · ${cost}": string;
		"Open tabs": string;
		"Waiting for selection": string;
		"Preparing element selector...": string;
		About: string;
		"You steer. Tabkyra works the tabs.": string;
		"An AI agent in your side panel, and a browser your coding agents can drive.": string;
		"The name joins tab and kyra, from Greek kybernētēs, “helmsman”.": string;
		"Built on the work of": string;
		"the agent bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the foreground guard.": string;
		"the original Sitegeist extension and the pi agent libraries it runs on.": string;
		"Version:": string;
		Website: string;
		Imprint: string;
		Privacy: string;
		"Checking for updates...": string;
		"Update Available": string;
		"A new version ({version}) is available": string;
		Update: string;
		"You're up to date": string;
		"Update Required": string;
		"A new version ({version}) is available. Please update to continue.": string;
		"Update Now": string;

		// Artifact previews (src/artifacts/)
		"Error loading media": string;
		"Error loading notebook": string;
		"Error loading presentation": string;
		"Error loading table": string;
		"Hidden slide": string;
		"Save it as {format} to preview it, or download it to open it on your computer.": string;
		"Table or raw text": string;
		"This browser can't play {filename}. Download it to play it elsewhere.": string;
		"This notebook has no cells.": string;
		"This presentation has no slides.": string;
		"This {type} can't be previewed here.": string;
		"Truncated for display": string;
		"showing the first {count}": string;
		"{cols} columns": string;
		"{count} slides": string;
		"1 slide": string;
		"{rows} rows": string;
		"columns after {count} not shown": string;
		"Chat name": string;
		"Could not delete the chat": string;
		"Could not rename the chat": string;
		"Delete all chats": string;
		"Delete chats older than 30 days": string;
		"Delete chats older than 90 days": string;
		"Deleted “{title}”": string;
		"Export all chats": string;
		"Import chats": string;
		"More actions": string;
		"No chats yet": string;
		"No matching chats": string;
		"Open now": string;
		"Past chats": string;
		Rename: string;
		"Search chats": string;
		Undo: string;
		"Untitled chat": string;
		// Pages
		Back: string;
		"Key saved": string;
		"Save recording as skill": string;
		Skill: string;
	}
}

const tabkyraTranslations = {
	en: {
		"A custom provider with that name already exists": "A custom provider with that name already exists",
		"API Key (optional)": "API Key (optional)",
		"API Type": "API Type",
		"Add Custom Provider": "Add Custom Provider",
		"Add Model": "Add Model",
		"Add at least one model": "Add at least one model",
		"Base URL": "Base URL",
		"Context window": "Context window",
		"Defaults to model ID": "Defaults to model ID",
		"Display Name (optional)": "Display Name (optional)",
		"Edit Custom Provider": "Edit Custom Provider",
		"Failed to save provider": "Failed to save provider",
		"Leave empty if the endpoint needs no key": "Leave empty if the endpoint needs no key",
		"Max output tokens": "Max output tokens",
		"Model ID": "Model ID",
		"Model IDs must be unique": "Model IDs must be unique",
		Models: "Models",
		"OpenAI-compatible base \u2014 usually ends in /v1.": "OpenAI-compatible base \u2014 usually ends in /v1.",
		"Please enter a base URL": "Please enter a base URL",
		"Please enter a provider name": "Please enter a provider name",
		"Provider Name": "Provider Name",
		"Provider saved": "Provider saved",
		Reasoning: "Reasoning",
		Remove: "Remove",
		"Root URL \u2014 the client appends /v1/messages.": "Root URL \u2014 the client appends /v1/messages.",
		Save: "Save",
		"That name is reserved by a built-in provider. Choose a different name.":
			"That name is reserved by a built-in provider. Choose a different name.",
		Vision: "Vision",
		"e.g. OpenRouter, Together, My Server": "e.g. OpenRouter, Together, My Server",
		"Permission request failed": "Permission request failed",
		"JavaScript Execution Permission Required": "JavaScript Execution Permission Required",
		"This extension needs permission to execute JavaScript code on web pages":
			"This extension needs permission to execute JavaScript code on web pages",
		"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.":
			"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.",
		"The AI can read and modify web page content when you ask it to":
			"The AI can read and modify web page content when you ask it to",
		"Code runs in an isolated environment with security safeguards":
			"Code runs in an isolated environment with security safeguards",
		"Network access is blocked to prevent data exfiltration":
			"Network access is blocked to prevent data exfiltration",
		"You can revoke this permission at any time in browser settings":
			"You can revoke this permission at any time in browser settings",
		"Writing JavaScript code...": "Writing JavaScript code...",
		"Execute JavaScript": "Execute JavaScript",
		"Preparing JavaScript...": "Preparing JavaScript...",
		"Getting skill": "Getting skill",
		"Got skill": "Got skill",
		"Listing skills": "Listing skills",
		"Creating skill": "Creating skill",
		"Created skill": "Created skill",
		"Updating skill": "Updating skill",
		"Updated skill": "Updated skill",
		"Rewriting skill": "Rewriting skill",
		"Rewritten skill": "Patched skill",
		"Deleting skill": "Deleting skill",
		"Processing skill...": "Processing skill...",
		"No skills found": "No skills found",
		"Skills for domain": "Skills for domain",
		"Deleted skill": "Deleted skill",
		Examples: "Examples",
		Library: "Library",
		"Command failed:": "Command failed:",
		"Why is this needed?": "Why is this needed?",
		"What this means:": "What this means:",
		"Continue Anyway": "Continue Anyway",
		"Requesting...": "Requesting...",
		"Grant Permission": "Grant Permission",
		"Navigating to": "Navigating to",
		"Click to open": "Click to open",
		"Waiting...": "Waiting...",
		Current: "Current",
		Locked: "Locked",
		"Export failed. Check console for details.": "Export failed. Check console for details.",
		"Invalid import file format": "Invalid import file format",
		"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.":
			"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.",
		"Imported {imported} sessions, skipped {skipped} duplicates":
			"Imported {imported} sessions, skipped {skipped} duplicates",
		"Imported {count} sessions": "Imported {count} sessions",
		"Import failed. Check console for details.": "Import failed. Check console for details.",
		Import: "Import",
		"Export All": "Export All",
		Export: "Export",
		"No sessions older than {days} days": "No sessions older than {days} days",
		"Delete {count} sessions older than {days} days?": "Delete {count} sessions older than {days} days?",
		"Failed to delete sessions. Check console for details.": "Failed to delete sessions. Check console for details.",
		"Delete Old": "Delete",
		"All sessions": "All sessions",
		"No sessions to delete": "No sessions to delete",
		"Delete ALL {count} sessions? This cannot be undone!": "Delete ALL {count} sessions? This cannot be undone!",
		"Older than 7 days": "Older than 7 days",
		"Older than 30 days": "Older than 30 days",
		"Older than 90 days": "Older than 90 days",
		"Search sessions...": "Search sessions...",
		"Total: {count} sessions · {messages} messages · ${cost}":
			"Total: {count} sessions · {messages} messages · ${cost}",
		"Open tabs": "Open tabs",
		"Waiting for selection": "Waiting for selection",
		"Preparing element selector...": "Preparing element selector...",
		About: "About",
		"You steer. Tabkyra works the tabs.": "You steer. Tabkyra works the tabs.",
		"An AI agent in your side panel, and a browser your coding agents can drive.":
			"An AI agent in your side panel, and a browser your coding agents can drive.",
		"The name joins tab and kyra, from Greek kybernētēs, “helmsman”.":
			"The name joins tab and kyra, from Greek kybernētēs, “helmsman”.",
		"Built on the work of": "Built on the work of",
		"the agent bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the foreground guard.":
			"the agent bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the foreground guard.",
		"the original Sitegeist extension and the pi agent libraries it runs on.":
			"the original Sitegeist extension and the pi agent libraries it runs on.",
		"Version:": "Version:",
		Website: "Website",
		Imprint: "Imprint",
		Privacy: "Privacy",
		"Checking for updates...": "Checking for updates...",
		"Update Available": "Update Available",
		"A new version ({version}) is available": "A new version ({version}) is available",
		Update: "Update",
		"You're up to date": "You're up to date",
		"Update Required": "Update Required",
		"A new version ({version}) is available. Please update to continue.":
			"A new version ({version}) is available. Please update to continue.",
		"Update Now": "Update Now",
		"Error loading media": "Error loading media",
		"Error loading notebook": "Error loading notebook",
		"Error loading presentation": "Error loading presentation",
		"Error loading table": "Error loading table",
		"Hidden slide": "Hidden slide",
		"Save it as {format} to preview it, or download it to open it on your computer.":
			"Save it as {format} to preview it, or download it to open it on your computer.",
		"Table or raw text": "Table or raw text",
		"This browser can't play {filename}. Download it to play it elsewhere.":
			"This browser can't play {filename}. Download it to play it elsewhere.",
		"This notebook has no cells.": "This notebook has no cells.",
		"This presentation has no slides.": "This presentation has no slides.",
		"This {type} can't be previewed here.": "This {type} can't be previewed here.",
		"Truncated for display": "Truncated for display",
		"showing the first {count}": "showing the first {count}",
		"{cols} columns": "{cols} columns",
		"{count} slides": "{count} slides",
		"1 slide": "1 slide",
		"{rows} rows": "{rows} rows",
		"columns after {count} not shown": "columns after {count} not shown",
		"Chat name": "Chat name",
		"Could not delete the chat": "Could not delete the chat",
		"Could not rename the chat": "Could not rename the chat",
		"Delete all chats": "Delete all chats",
		"Delete chats older than 30 days": "Delete chats older than 30 days",
		"Delete chats older than 90 days": "Delete chats older than 90 days",
		"Deleted “{title}”": "Deleted “{title}”",
		"Export all chats": "Export all chats",
		"Import chats": "Import chats",
		"More actions": "More actions",
		"No chats yet": "No chats yet",
		"No matching chats": "No matching chats",
		"Open now": "Open now",
		"Past chats": "Past chats",
		Rename: "Rename",
		"Search chats": "Search chats",
		Undo: "Undo",
		"Untitled chat": "Untitled chat",
		Back: "Back",
		"Save recording as skill": "Save recording as skill",
		Skill: "Skill",
	},
	de: {
		"A custom provider with that name already exists": "A custom provider with that name already exists",
		"API Key (optional)": "API Key (optional)",
		"API Type": "API Type",
		"Add Custom Provider": "Add Custom Provider",
		"Add Model": "Add Model",
		"Add at least one model": "Add at least one model",
		"Base URL": "Base URL",
		"Context window": "Context window",
		"Defaults to model ID": "Defaults to model ID",
		"Display Name (optional)": "Display Name (optional)",
		"Edit Custom Provider": "Edit Custom Provider",
		"Failed to save provider": "Failed to save provider",
		"Leave empty if the endpoint needs no key": "Leave empty if the endpoint needs no key",
		"Max output tokens": "Max output tokens",
		"Model ID": "Model ID",
		"Model IDs must be unique": "Model IDs must be unique",
		Models: "Models",
		"OpenAI-compatible base \u2014 usually ends in /v1.": "OpenAI-compatible base \u2014 usually ends in /v1.",
		"Please enter a base URL": "Please enter a base URL",
		"Please enter a provider name": "Please enter a provider name",
		"Provider Name": "Provider Name",
		"Provider saved": "Provider saved",
		Reasoning: "Reasoning",
		Remove: "Remove",
		"Root URL \u2014 the client appends /v1/messages.": "Root URL \u2014 the client appends /v1/messages.",
		Save: "Save",
		"That name is reserved by a built-in provider. Choose a different name.":
			"That name is reserved by a built-in provider. Choose a different name.",
		Vision: "Vision",
		"e.g. OpenRouter, Together, My Server": "e.g. OpenRouter, Together, My Server",
		"Permission request failed": "Berechtigungsanfrage fehlgeschlagen",
		"JavaScript Execution Permission Required": "JavaScript-Ausführungsberechtigung erforderlich",
		"This extension needs permission to execute JavaScript code on web pages":
			"Diese Erweiterung benötigt die Berechtigung, JavaScript-Code auf Webseiten auszuführen",
		"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.":
			"Das JavaScript-REPL-Tool ermöglicht es der KI, Webseiten in Ihrem Auftrag zu lesen und damit zu interagieren. Dies erfordert die userScripts-Berechtigung, um Code sicher auszuführen.",
		"The AI can read and modify web page content when you ask it to":
			"Die KI kann Webseiteninhalte lesen und ändern, wenn Sie es verlangen",
		"Code runs in an isolated environment with security safeguards":
			"Code wird in einer isolierten Umgebung mit Sicherheitsvorkehrungen ausgeführt",
		"Network access is blocked to prevent data exfiltration":
			"Netzwerkzugriff ist blockiert, um Datenexfiltration zu verhindern",
		"You can revoke this permission at any time in browser settings":
			"Sie können diese Berechtigung jederzeit in den Browsereinstellungen widerrufen",
		"Writing JavaScript code...": "Schreibe JavaScript-Code...",
		"Execute JavaScript": "Führe JavaScript aus",
		"Preparing JavaScript...": "Bereite JavaScript vor...",
		"Getting skill": "Hole Skill",
		"Got skill": "Skill erhalten",
		"Listing skills": "Liste Skills auf",
		"Creating skill": "Erstelle Skill",
		"Created skill": "Skill erstellt",
		"Updating skill": "Aktualisiere Skill",
		"Updated skill": "Skill aktualisiert",
		"Rewriting skill": "Patche Skill",
		"Rewritten skill": "Skill gepatcht",
		"Deleting skill": "Lösche Skill",
		"Processing skill...": "Verarbeite Skill...",
		"No skills found": "Keine Skills gefunden",
		"Skills for domain": "Skills für Domain",
		"Deleted skill": "Skill gelöscht",
		Examples: "Beispiele",
		Library: "Bibliothek",
		"Command failed:": "Befehl fehlgeschlagen:",
		"Why is this needed?": "Warum ist das notwendig?",
		"What this means:": "Was das bedeutet:",
		"Continue Anyway": "Trotzdem fortfahren",
		"Requesting...": "Anfrage läuft...",
		"Grant Permission": "Berechtigung erteilen",
		"Navigating to": "Navigiere zu",
		"Click to open": "Klicken zum Öffnen",
		"Waiting...": "Warte...",
		Current: "Aktuell",
		Locked: "Gesperrt",
		"Export failed. Check console for details.": "Export fehlgeschlagen. Prüfen Sie die Konsole für Details.",
		"Invalid import file format": "Ungültiges Import-Dateiformat",
		"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.":
			"{count} doppelte Sitzungen gefunden. OK zum Überschreiben, Abbrechen zum Überspringen.",
		"Imported {imported} sessions, skipped {skipped} duplicates":
			"{imported} Sitzungen importiert, {skipped} Duplikate übersprungen",
		"Imported {count} sessions": "{count} Sitzungen importiert",
		"Import failed. Check console for details.": "Import fehlgeschlagen. Prüfen Sie die Konsole für Details.",
		Import: "Importieren",
		"Export All": "Alle exportieren",
		Export: "Exportieren",
		"No sessions older than {days} days": "Keine Sitzungen älter als {days} Tage",
		"Delete {count} sessions older than {days} days?": "{count} Sitzungen älter als {days} Tage löschen?",
		"Failed to delete sessions. Check console for details.":
			"Löschen fehlgeschlagen. Prüfen Sie die Konsole für Details.",
		"Delete Old": "Löschen",
		"All sessions": "Alle Sitzungen",
		"No sessions to delete": "Keine Sitzungen zum Löschen",
		"Delete ALL {count} sessions? This cannot be undone!":
			"ALLE {count} Sitzungen löschen? Dies kann nicht rückgängig gemacht werden!",
		"Older than 7 days": "Älter als 7 Tage",
		"Older than 30 days": "Älter als 30 Tage",
		"Older than 90 days": "Älter als 90 Tage",
		"Search sessions...": "Sitzungen durchsuchen...",
		"Total: {count} sessions · {messages} messages · ${cost}":
			"Gesamt: {count} Sitzungen · {messages} Nachrichten · ${cost}",
		"Open tabs": "Offene Tabs",
		"Waiting for selection": "Warte auf Auswahl",
		"Preparing element selector...": "Bereite Element-Auswahl vor...",
		About: "Über",
		"You steer. Tabkyra works the tabs.": "Du steuerst. Tabkyra bedient die Tabs.",
		"An AI agent in your side panel, and a browser your coding agents can drive.":
			"Ein KI-Agent in deiner Seitenleiste und ein Browser, den deine Coding-Agenten steuern können.",
		"The name joins tab and kyra, from Greek kybernētēs, “helmsman”.":
			"Der Name verbindet „Tab“ und „kyra“, von griechisch kybernētēs, „Steuermann“.",
		"Built on the work of": "Aufgebaut auf der Arbeit von",
		"the agent bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the foreground guard.":
			"Agenten-Bridge, CLI und MCP-Server, Tab-Gruppen für Agenten, Seitenleisten pro Tab und den Vordergrundschutz.",
		"the original Sitegeist extension and the pi agent libraries it runs on.":
			"die ursprüngliche Sitegeist-Erweiterung und die pi-Agentenbibliotheken, auf denen sie läuft.",
		"Version:": "Version:",
		Website: "Webseite",
		Imprint: "Impressum",
		Privacy: "Datenschutz",
		"Checking for updates...": "Suche nach Updates...",
		"Update Available": "Update verfügbar",
		"A new version ({version}) is available": "Eine neue Version ({version}) ist verfügbar",
		Update: "Aktualisieren",
		"You're up to date": "Sie sind auf dem neuesten Stand",
		"Update Required": "Update erforderlich",
		"A new version ({version}) is available. Please update to continue.":
			"Eine neue Version ({version}) ist verfügbar. Bitte aktualisieren Sie, um fortzufahren.",
		"Update Now": "Jetzt aktualisieren",
		"Error loading media": "Fehler beim Laden der Mediendatei",
		"Error loading notebook": "Fehler beim Laden des Notebooks",
		"Error loading presentation": "Fehler beim Laden der Präsentation",
		"Error loading table": "Fehler beim Laden der Tabelle",
		"Hidden slide": "Ausgeblendete Folie",
		"Save it as {format} to preview it, or download it to open it on your computer.":
			"Speichern Sie die Datei als {format}, um sie in der Vorschau zu sehen, oder laden Sie sie herunter, um sie auf Ihrem Computer zu öffnen.",
		"Table or raw text": "Tabelle oder Rohtext",
		"This browser can't play {filename}. Download it to play it elsewhere.":
			"Dieser Browser kann {filename} nicht abspielen. Laden Sie die Datei herunter, um sie anderswo abzuspielen.",
		"This notebook has no cells.": "Dieses Notebook hat keine Zellen.",
		"This presentation has no slides.": "Diese Präsentation hat keine Folien.",
		"This {type} can't be previewed here.": "Für diese Datei ({type}) gibt es hier keine Vorschau.",
		"Truncated for display": "Für die Anzeige gekürzt",
		"showing the first {count}": "die ersten {count} werden angezeigt",
		"{cols} columns": "{cols} Spalten",
		"{count} slides": "{count} Folien",
		"1 slide": "1 Folie",
		"{rows} rows": "{rows} Zeilen",
		"columns after {count} not shown": "Spalten nach {count} nicht angezeigt",
		"Chat name": "Chat-Name",
		"Could not delete the chat": "Der Chat konnte nicht gelöscht werden",
		"Could not rename the chat": "Der Chat konnte nicht umbenannt werden",
		"Delete all chats": "Alle Chats löschen",
		"Delete chats older than 30 days": "Chats älter als 30 Tage löschen",
		"Delete chats older than 90 days": "Chats älter als 90 Tage löschen",
		"Deleted “{title}”": "„{title}“ gelöscht",
		"Export all chats": "Alle Chats exportieren",
		"Import chats": "Chats importieren",
		"More actions": "Weitere Aktionen",
		"No chats yet": "Noch keine Chats",
		"No matching chats": "Keine passenden Chats",
		"Open now": "Geöffnet",
		"Past chats": "Frühere Chats",
		Rename: "Umbenennen",
		"Search chats": "Chats durchsuchen",
		Undo: "Rückgängig",
		"Untitled chat": "Chat ohne Titel",
		Back: "Zurück",
		"Save recording as skill": "Aufnahme als Skill speichern",
		Skill: "Skill",
	},
};

// Merge web-ui translations with tabkyra translations
const mergedTranslations = {
	en: { ...webUiTranslations.en, ...tabkyraTranslations.en },
	de: { ...webUiTranslations.de, ...tabkyraTranslations.de },
};

setTranslations(mergedTranslations);
