ALTER TABLE `processingLogs` MODIFY COLUMN `step` enum('intent_detected','mock_api_called','response_drafted','sent','escalated','send_failed') NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledgeChunks` ADD `embeddingDim` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `status` enum('queued','sent','failed','delivered') DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `twilioSid` varchar(64);--> statement-breakpoint
ALTER TABLE `messages` ADD `correlationId` varchar(64);--> statement-breakpoint
ALTER TABLE `messages` ADD `sendError` varchar(256);--> statement-breakpoint
ALTER TABLE `processingLogs` ADD `correlationId` varchar(64);--> statement-breakpoint
ALTER TABLE `rejections` ADD `embeddingDim` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `styleExamples` ADD `embeddingDim` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledgeChunks` ADD CONSTRAINT `knowledge_topic_title_unique` UNIQUE(`topic`,`title`);--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_twilioSid_unique` UNIQUE(`twilioSid`);