CREATE TABLE "message_personalization_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_personalization_fields_confidence_check" CHECK ("message_personalization_fields"."confidence" >= 0 and "message_personalization_fields"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "message_personalization_fields" ADD CONSTRAINT "message_personalization_fields_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_personalization_fields" ADD CONSTRAINT "message_personalization_fields_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_personalization_fields_message_name_unique" ON "message_personalization_fields" USING btree ("message_id","name");