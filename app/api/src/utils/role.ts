export function assertTreasury(role: string | undefined): void {
  if (role !== "treasury") {
    throw new Error("Treasury privileges required");
  }
}

export function assertNonEmpty(role: string | undefined): void {
  if (!role) {
    throw new Error("Node role required");
  }
}
