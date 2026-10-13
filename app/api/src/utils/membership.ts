/**
 * Membership enforcement utilities
 * Ensures only active members can perform network operations
 */

/**
 * Asserts that the node is an active member of the Bitcorn network
 * @param status - The membership status string from the database
 * @throws Error if the node is not an active member
 */
export function assertActiveMember(status: string) {
  if (status !== "active_member") {
    throw new Error("Node is not authorized to participate in Bitcorn network");
  }
}
