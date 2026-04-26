CREATE TABLE `errorAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`key` varchar(256) NOT NULL,
	`kind` enum('spike','flap') NOT NULL,
	`source` varchar(128) NOT NULL,
	`message` text,
	`count` int NOT NULL,
	`windowSeconds` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `errorAlerts_id` PRIMARY KEY(`id`)
);
