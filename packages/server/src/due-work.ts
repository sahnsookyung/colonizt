type DueEntry = {
  key: string;
  dueAt: number;
  version: number;
};

const parentIndex = (index: number): number => Math.floor((index - 1) / 2);
const leftChildIndex = (index: number): number => index * 2 + 1;

export class DueWorkIndex {
  private readonly heap: DueEntry[] = [];
  private readonly entries = new Map<string, { dueAt: number; version: number }>();
  private version = 0;

  set(key: string, dueAt: number): void {
    this.delete(key);
    if (!Number.isFinite(dueAt)) return;
    const entry: DueEntry = { key, dueAt, version: this.version += 1 };
    this.entries.set(key, { dueAt, version: entry.version });
    this.push(entry);
  }

  delete(key: string): void {
    if (!this.entries.delete(key)) return;
    this.version += 1;
  }

  claimDue(now: number, limit = Number.POSITIVE_INFINITY): string[] {
    const keys: string[] = [];
    while (keys.length < limit) {
      const entry = this.peekValid();
      if (!entry || entry.dueAt > now) break;
      this.pop();
      this.entries.delete(entry.key);
      keys.push(entry.key);
    }
    return keys;
  }

  nextDueAt(): number | undefined {
    return this.peekValid()?.dueAt;
  }

  clear(): void {
    this.heap.length = 0;
    this.entries.clear();
    this.version += 1;
  }

  private peekValid(): DueEntry | undefined {
    while (this.heap.length > 0) {
      const entry = this.heap[0]!;
      const current = this.entries.get(entry.key);
      if (current?.dueAt === entry.dueAt && current.version === entry.version) return entry;
      this.pop();
    }
    return undefined;
  }

  private push(entry: DueEntry): void {
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
  }

  private pop(): DueEntry | undefined {
    const root = this.heap[0];
    const tail = this.heap.pop();
    if (tail && this.heap.length > 0) {
      this.heap[0] = tail;
      this.bubbleDown(0);
    }
    return root;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = parentIndex(current);
      if (this.compare(this.heap[parent]!, this.heap[current]!) <= 0) break;
      this.swap(parent, current);
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = leftChildIndex(current);
      const right = left + 1;
      let smallest = current;
      if (left < this.heap.length && this.compare(this.heap[left]!, this.heap[smallest]!) < 0) smallest = left;
      if (right < this.heap.length && this.compare(this.heap[right]!, this.heap[smallest]!) < 0) smallest = right;
      if (smallest === current) break;
      this.swap(current, smallest);
      current = smallest;
    }
  }

  private compare(left: DueEntry, right: DueEntry): number {
    return left.dueAt - right.dueAt || left.key.localeCompare(right.key);
  }

  private swap(left: number, right: number): void {
    const current = this.heap[left]!;
    this.heap[left] = this.heap[right]!;
    this.heap[right] = current;
  }
}
