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
