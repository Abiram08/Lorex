/** Database, collection, workspace, and agent identity resolution. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export interface Identity {
  database: string;
  collection: string;
  databaseLabel: string;
  collectionLabel: string;
  agent: string;
  workspace?: string;
  provenance: IdentityProvenance;
  warning?: string;
}

export interface IdentityProvenance {
  database: "explicit" | "workspace" | "git-email" | "git-name" | "machine";
  collection: "explicit" | "workspace" | "git-remote" | "path";
  shareable: boolean;
}

export function resolveWorkspace(explicit?: string): string | undefined {
  const raw = (explicit ?? process.env.LOREX_WORKSPACE ?? "").trim();
  return raw ? slug(raw) : undefined;
}

export function resolveAgent(explicit?: string): string {
  const direct = (explicit ?? process.env.LOREX_AGENT ?? "").trim();
  if (direct) return agentSlug(direct);
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID) return "cursor";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_SESSION_ID) return "codex";
  if (process.env.TERM_PROGRAM === "vscode") return "vscode";
  if (process.env.GITHUB_ACTIONS) return "github-actions";
  return "unknown";
}

function git(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      encoding: "utf8",
      windowsHide: true,
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "lorex"
  );
}

function agentSlug(input: string): string {
  return slug(input).replace(/_/g, "-");
}

function hash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function redactEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "user***";
  const head = (user ?? "u").slice(0, 2);
  return `${head}***@${domain}`;
}

function redactRemote(remote: string): string {
  try {
    const normalized = remote
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    const u = new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    const repo = parts[parts.length - 1] ?? "repo";
    return `${u.hostname}/${repo}`;
  } catch {
    return "repo/***";
  }
}

function deriveDatabase(
  cwd: string,
): { name: string; label: string; via: IdentityProvenance["database"] } {
  const email = git(["config", "user.email"], cwd);
  if (email) return { name: slug(`user_${hash(email)}`), label: redactEmail(email), via: "git-email" };
  const name = git(["config", "user.name"], cwd);
  if (name) return { name: slug(`user_${hash(name)}`), label: `user:${name.slice(0, 24)}`, via: "git-name" };
  const fallback = `local_${hash(`${process.platform}:${process.env.USER ?? process.env.USERNAME ?? "anon"}`)}`;
  return { name: slug(fallback), label: "(local machine)", via: "machine" };
}

function deriveCollection(
  cwd: string,
): { name: string; label: string; via: IdentityProvenance["collection"] } {
  const remote = git(["remote", "get-url", "origin"], cwd);
  if (remote) {
    const normalized = remote
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    return { name: slug(`repo_${hash(normalized)}`), label: redactRemote(remote), via: "git-remote" };
  }
  const abs = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = abs.split("/").filter(Boolean).pop() ?? "path";
  return { name: slug(`path_${hash(abs)}`), label: `path:${leaf}`, via: "path" };
}

export function resolveIdentity(
  cwd: string,
  overrides?: {
    database?: string;
    collection?: string;
    workspace?: string;
    agent?: string;
  },
): Identity {
  const workspace = resolveWorkspace(overrides?.workspace);
  const agent = resolveAgent(overrides?.agent);

  const db = overrides?.database
    ? { name: slug(overrides.database), label: overrides.database, via: "explicit" as const }
    : workspace
      ? { name: slug(`ws_${workspace}`), label: `workspace:${workspace}`, via: "workspace" as const }
      : deriveDatabase(cwd);

  const coll = overrides?.collection
    ? { name: slug(overrides.collection), label: overrides.collection, via: "explicit" as const }
    : workspace
      ? { name: slug(workspace), label: workspace, via: "workspace" as const }
      : deriveCollection(cwd);

  const declared = new Set(["explicit", "workspace"]);
  const shareable = declared.has(db.via) && declared.has(coll.via);

  let warning: string | undefined;
  if (!shareable) {
    const reasons: string[] = [];
    if (db.via === "machine") reasons.push("no git identity, using this machine and OS user");
    else if (db.via === "git-name") reasons.push("no git email, using user.name");
    if (coll.via === "path") reasons.push("no git remote, using the directory path");
    warning =
      `Identity is derived, not declared${reasons.length ? ` (${reasons.join("; ")})` : ""}. ` +
      "Another agent reaches this memory only if it resolves to exactly the same values. " +
      "Set LOREX_WORKSPACE or --workspace to share deliberately.";
  }

  return {
    database: db.name,
    collection: coll.name,
    databaseLabel: db.label,
    collectionLabel: coll.label,
    agent,
    workspace,
    provenance: { database: db.via, collection: coll.via, shareable },
    warning,
  };
}

export function isGitRepo(cwd: string): boolean {
  return existsSync(`${cwd}/.git`) || git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}
