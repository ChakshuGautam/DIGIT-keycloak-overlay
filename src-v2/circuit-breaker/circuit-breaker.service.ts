import { Injectable } from "@nestjs/common";

interface CircuitState {
  status: "closed" | "open" | "half-open";
  failures: number;
  lastFailure: number;
  nextAttempt: number;
}

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 30_000;

@Injectable()
export class CircuitBreakerService {
  private circuits = new Map<string, CircuitState>();

  private getOrCreate(name: string): CircuitState {
    let circuit = this.circuits.get(name);
    if (!circuit) {
      circuit = { status: "closed", failures: 0, lastFailure: 0, nextAttempt: 0 };
      this.circuits.set(name, circuit);
    }
    return circuit;
  }

  async exec<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const circuit = this.getOrCreate(name);

    if (circuit.status === "open") {
      if (Date.now() < circuit.nextAttempt) {
        throw new Error(`Circuit ${name} is OPEN — rejecting request`);
      }
      // Past nextAttempt — transition to half-open
      circuit.status = "half-open";
    }

    try {
      const result = await fn();
      // Success: reset to closed
      circuit.status = "closed";
      circuit.failures = 0;
      return result;
    } catch (err) {
      circuit.failures++;
      circuit.lastFailure = Date.now();
      if (circuit.failures >= FAILURE_THRESHOLD) {
        circuit.status = "open";
        circuit.nextAttempt = Date.now() + RESET_TIMEOUT_MS;
      }
      throw err;
    }
  }

  getState(name: string): string {
    return this.getOrCreate(name).status;
  }

  getStateNumeric(name: string): number {
    const status = this.getOrCreate(name).status;
    switch (status) {
      case "closed":
        return 0;
      case "half-open":
        return 1;
      case "open":
        return 2;
    }
  }

  getAllStates(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, state] of this.circuits) {
      result[name] = state.status;
    }
    return result;
  }
}
