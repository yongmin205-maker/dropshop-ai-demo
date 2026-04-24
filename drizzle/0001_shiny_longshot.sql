CREATE TABLE `conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`phone` varchar(32) NOT NULL,
	`customerName` varchar(128),
	`lastIntent` varchar(64),
	`escalated` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversations_phone_unique` UNIQUE(`phone`)
);
--> statement-breakpoint
CREATE TABLE `escalations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversationId` int NOT NULL,
	`messageId` int NOT NULL,
	`reason` varchar(256) NOT NULL,
	`severity` enum('high','critical') NOT NULL DEFAULT 'critical',
	`status` enum('open','resolved') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	CONSTRAINT `escalations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversationId` int NOT NULL,
	`direction` enum('inbound','outbound') NOT NULL,
	`sender` enum('customer','ai','manager') NOT NULL,
	`body` text NOT NULL,
	`intent` varchar(64),
	`mode` enum('simulator','live') NOT NULL DEFAULT 'simulator',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mockCustomers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`phone` varchar(32) NOT NULL,
	`name` varchar(128) NOT NULL,
	`membership` enum('none','silver','gold') NOT NULL DEFAULT 'none',
	`address` varchar(256),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mockCustomers_id` PRIMARY KEY(`id`),
	CONSTRAINT `mockCustomers_phone_unique` UNIQUE(`phone`)
);
--> statement-breakpoint
CREATE TABLE `mockOrders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderNumber` varchar(32) NOT NULL,
	`customerPhone` varchar(32) NOT NULL,
	`status` enum('Awaiting Pickup','Cleaning','Ready to Deliver','Completed') NOT NULL,
	`itemsSummary` varchar(256) NOT NULL,
	`totalCents` int NOT NULL DEFAULT 0,
	`etaText` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mockOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `mockOrders_orderNumber_unique` UNIQUE(`orderNumber`)
);
--> statement-breakpoint
CREATE TABLE `mockPriceList` (
	`id` int AUTO_INCREMENT NOT NULL,
	`category` varchar(64) NOT NULL,
	`itemName` varchar(128) NOT NULL,
	`priceCents` int NOT NULL,
	`notes` varchar(256),
	CONSTRAINT `mockPriceList_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `processingLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversationId` int NOT NULL,
	`messageId` int NOT NULL,
	`step` enum('intent_detected','mock_api_called','response_drafted','sent','escalated') NOT NULL,
	`label` varchar(256) NOT NULL,
	`detail` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `processingLogs_id` PRIMARY KEY(`id`)
);
