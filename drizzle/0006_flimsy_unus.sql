CREATE TABLE `errorLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`level` enum('error','warn') NOT NULL DEFAULT 'error',
	`source` varchar(128) NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`context` json,
	`correlationId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `errorLogs_id` PRIMARY KEY(`id`)
);
