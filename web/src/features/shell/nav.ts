import type { LucideIcon } from "lucide-react";
import { Activity, Boxes, FileText, Gauge, GitBranch, Layers, Server, Settings2, Tags } from "lucide-react";

/**
 * The rail is a static table (PLAN §5): routes are listed here, never derived from the router at runtime, so a missing
 * route is a build error rather than a dead link. `key` is the second key of the `g`-prefixed vim sequence.
 */
export type NavPath =
  | "/"
  | "/apps"
  | "/scheduler"
  | "/nodes"
  | "/node-labels"
  | "/tools/conf"
  | "/tools/jmx"
  | "/tools/stacks"
  | "/tools/logs";

/** Which live figure (if any) decorates the entry. */
export type NavBadge = "running" | "pending" | "warnNodes";

export interface NavItem {
  to: NavPath;
  label: string;
  icon: LucideIcon;
  /** one-line description for the command palette */
  description: string;
  badge?: NavBadge;
  key?: string;
}

export const NAV_OVERVIEW: NavItem = {
  to: "/",
  label: "Overview",
  icon: Gauge,
  description: "Cluster about, metrics, utilisation history and the now-running rail",
  badge: "pending",
  key: "o",
};

export const NAV_PRIMARY: NavItem[] = [
  {
    to: "/apps",
    label: "Applications",
    icon: Boxes,
    description: "Every YARN application, filterable, sortable and live",
    badge: "running",
    key: "a",
  },
  {
    to: "/scheduler",
    label: "Scheduler",
    icon: GitBranch,
    description: "Queue tree: capacity, used, headroom, users, AM limits",
    key: "s",
  },
  {
    to: "/nodes",
    label: "Nodes",
    icon: Server,
    description: "NodeManagers with state, racks, resources and containers",
    badge: "warnNodes",
    key: "n",
  },
  {
    to: "/node-labels",
    label: "Node labels",
    icon: Tags,
    description: "Partitions, exclusivity and node-to-label mappings",
  },
];

export const NAV_TOOLS: NavItem[] = [
  { to: "/tools/conf", label: "Configuration", icon: Settings2, description: "ResourceManager configuration dump" },
  { to: "/tools/jmx", label: "JMX", icon: Activity, description: "ResourceManager JMX beans" },
  { to: "/tools/stacks", label: "Stacks", icon: Layers, description: "ResourceManager thread dump" },
  { to: "/tools/logs", label: "Daemon logs", icon: FileText, description: "ResourceManager log files, tail and search" },
];

export const NAV_ALL: NavItem[] = [NAV_OVERVIEW, ...NAV_PRIMARY, ...NAV_TOOLS];
