CREATE TABLE `drafts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversationId` int NOT NULL,
	`inboundMessageId` int NOT NULL,
	`intent` varchar(64) NOT NULL,
	`body` text NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`status` enum('pending_approval','approved','rejected','superseded') NOT NULL DEFAULT 'pending_approval',
	`ragContext` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drafts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeChunks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`topic` varchar(64) NOT NULL,
	`title` varchar(256) NOT NULL,
	`body` text NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeChunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rejections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftId` int NOT NULL,
	`intent` varchar(64) NOT NULL,
	`customerBody` text NOT NULL,
	`rejectedReply` text NOT NULL,
	`reason` text NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rejections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `styleExamples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftId` int NOT NULL,
	`intent` varchar(64) NOT NULL,
	`customerBody` text NOT NULL,
	`approvedReply` text NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `styleExamples_id` PRIMARY KEY(`id`)
);
