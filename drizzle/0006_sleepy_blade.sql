CREATE INDEX "messages_internet_message_id_idx" ON "messages" USING btree ("internet_message_id");--> statement-breakpoint
CREATE INDEX "messages_sent_history_idx" ON "messages" USING btree ("direction","status","sent_at");--> statement-breakpoint
CREATE INDEX "messages_send_attempted_at_idx" ON "messages" USING btree ("send_attempted_at");