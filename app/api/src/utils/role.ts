export function assertTreasury(role: string | undefined): void {
  if (role !== "treasury") {
    throw new Error("Treasury privileges required");
  }
}
