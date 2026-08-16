export const MAX_EXTERNAL_SUBREQUESTS = 50;

export class ExternalRequestBudget {
  private usedCount = 0;

  constructor(private readonly limit = MAX_EXTERNAL_SUBREQUESTS) {}

  tryTake(): boolean {
    if (this.usedCount >= this.limit) return false;
    this.usedCount += 1;
    return true;
  }

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }
}
