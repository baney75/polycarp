/**
 * What the side panel and the native host say to each other about Connect: the methods, the
 * shapes of their answers. Types and constants only, so the extension and the CLI both import it.
 * No answer ever carries a secret, a token hash or the passcode.
 */

export type ConnectRoute = "none" | "remote" | "hub" | "link";

export interface ConnectDevice {
	name: string;
	online: boolean;
	extensionConnected: boolean;
	sessions: number;
	busy: boolean;
	/** ISO time, or null when the hub never saw it. */
	lastSeen: string | null;
}

export interface ConnectStatus {
	route: ConnectRoute;
	/** The public origin (remote and hub routes). The connector URL is this plus /mcp. */
	publicUrl?: string;
	passcodeSet: boolean;
	/** This device's link to a hub; present whenever link.json loads, whatever the route is (a hub box can link to itself). */
	link?: { hubUrl: string; name: string; online: boolean; busy: boolean; manage: boolean };
	hub?: { devices: ConnectDevice[] };
	theme: { preset: string; accent?: string; mode?: "light" | "dark" };
	/** A config file that is present but unreadable, in a sentence; the route reads as none until it is fixed. */
	problem?: string;
}

export interface ApprovalCode {
	code: string;
	/** ms since the epoch. */
	expiresAt: number;
	connectorUrl: string;
}

export interface DeviceCode {
	code: string;
	expiresAt: number;
	hubUrl: string;
}

export interface JoinResult {
	name: string;
	manage: boolean;
}

/** Methods the side panel may call. Everything else is refused in the background worker and again in the host. */
export const CONNECT_METHODS = ["status", "approvalCode", "deviceCode", "setBusy", "joinHub", "setTheme"] as const;
export type ConnectMethod = (typeof CONNECT_METHODS)[number];

export const CONNECT_PORT = "tabkyra-connect";

/** side panel -> background */
export interface ConnectRequest {
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

/** background -> side panel */
export interface ConnectReply {
	id: number;
	result?: unknown;
	error?: { code: string; message: string };
	progress?: Record<string, unknown>;
}

/** Codes minted per window; the host refuses more (10 per 10 minutes). */
export const CODE_LIMIT = 10;
export const CODE_WINDOW_MS = 10 * 60_000;
