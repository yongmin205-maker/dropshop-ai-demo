/**
 * The single source of truth for "what tools does the Owner Assistant
 * have?". The Planner LLM consumes TOOL_DESCRIPTIONS_FOR_PROMPT; the
 * Executor looks up by name via TOOL_REGISTRY.
 *
 * Adding a new tool: implement it as a ToolDefinition somewhere under
 * `./tools/`, import + register it here, and add its name to
 * server/ownerAssistant/types.ts → TOOL_NAMES. That's it.
 */

import type { AnyToolDefinition, ToolName } from "../types";
import { findCustomerByPhoneOrName } from "./findCustomer";
import {
  getActiveOrdersByStatus,
  getCustomerRecentOrders,
  getOrderDetails,
} from "./orders";
import {
  aggregateNewCustomers,
  aggregateRepeatCustomers,
  aggregateRevenue,
  findInactiveCustomers,
} from "./aggregates";
import { compareTimeWindows } from "./compare";
import {
  aggregateRevenueLive,
  countActiveGarments,
  fetchLiveOrder,
} from "./livePos";

export const TOOL_REGISTRY: Readonly<Record<ToolName, AnyToolDefinition>> = {
  findCustomerByPhoneOrName: findCustomerByPhoneOrName as AnyToolDefinition,
  getCustomerRecentOrders: getCustomerRecentOrders as AnyToolDefinition,
  getOrderDetails: getOrderDetails as AnyToolDefinition,
  getActiveOrdersByStatus: getActiveOrdersByStatus as AnyToolDefinition,
  fetchLiveOrder: fetchLiveOrder as AnyToolDefinition,
  countActiveGarments: countActiveGarments as AnyToolDefinition,
  aggregateRevenueLive: aggregateRevenueLive as AnyToolDefinition,
  aggregateRevenue: aggregateRevenue as AnyToolDefinition,
  aggregateNewCustomers: aggregateNewCustomers as AnyToolDefinition,
  aggregateRepeatCustomers: aggregateRepeatCustomers as AnyToolDefinition,
  findInactiveCustomers: findInactiveCustomers as AnyToolDefinition,
  compareTimeWindows: compareTimeWindows as AnyToolDefinition,
};

/**
 * Compact tool catalogue the Planner LLM gets fed as part of its
 * system prompt. Keep it small: name + category + description. The
 * model doesn't see the zod schemas (Vertex / Gemini JSON-mode keeps
 * argument types deterministic at the response layer).
 */
export function toolCatalogueForPrompt(): Array<{
  name: ToolName;
  category: string;
  description: string;
  argsExample: unknown;
}> {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    argsExample: t.argsExample,
  }));
}
