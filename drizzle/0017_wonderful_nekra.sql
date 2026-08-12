ALTER TABLE "agent_runs" ADD COLUMN "response_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tool_usage" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cost_availability" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_cost_availability_check" CHECK ("agent_runs"."cost_availability" is null or "agent_runs"."cost_availability" in ('available', 'unavailable'));