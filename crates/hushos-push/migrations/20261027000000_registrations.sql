-- Handle → token, and nothing about who or where (docs/devices-design.md 5, "The relay").
-- Handles and deletion secrets are kept only as hashes; a token Apple or Google report dead is
-- deleted with every handle that uses it, so there is no dead flag and no timestamp.
create table registrations (
    handle_key bytea primary key check (octet_length(handle_key) = 32),
    platform text not null check (platform in ('apns', 'apns-sandbox', 'fcm')),
    token text not null check (length(token) between 1 and 512),
    secret_hash bytea not null check (octet_length(secret_hash) = 32)
);

create index registrations_token_idx on registrations (platform, token);
