import type {
  AccountDiscoveryInput,
  AccountDiscoveryOutput,
  AccountResearchInput,
  AccountResearchOutput,
  ContactDiscoveryInput,
  ContactDiscoveryOutput,
  PersonalizationInput,
  PersonalizationOutput,
} from "@/modules/agents/schemas";
import type { AgentResult } from "@/modules/agents/types";

export interface ObservableAgent {
  readonly name: string;
  readonly model: string;
  /**
   * The lane's reasoning effort, as configured — `High` for research, `Instant`
   * for the fast lane.
   *
   * Optional, and deliberately so: the mock agents have no lane, and a run
   * recorded before the column existed has no answer. Both are rendered as the
   * model alone rather than as an invented effort.
   */
  readonly effort?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
}

export interface AccountDiscoveryAgent extends ObservableAgent {
  discover(
    input: AccountDiscoveryInput,
  ): Promise<AgentResult<AccountDiscoveryOutput>>;
}

export interface AccountResearchAgent extends ObservableAgent {
  research(
    input: AccountResearchInput,
  ): Promise<AgentResult<AccountResearchOutput>>;
}

export interface ContactDiscoveryAgent extends ObservableAgent {
  discover(
    input: ContactDiscoveryInput,
  ): Promise<AgentResult<ContactDiscoveryOutput>>;
}

export interface PersonalizationAgent extends ObservableAgent {
  personalize(
    input: PersonalizationInput,
  ): Promise<AgentResult<PersonalizationOutput>>;
}
