CREATE TABLE `ownerConversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerOpenId` varchar(64) NOT NULL,
	`title` varchar(256),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ownerConversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ownerMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversationId` int NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`contentMarkdown` text NOT NULL,
	`trace` json,
	`totalLatencyMs` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ownerMessages_id` PRIMARY KEY(`id`)
);
