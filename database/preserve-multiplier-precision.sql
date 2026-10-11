-- Keep existing saved picks unchanged while preserving new Engine 1.0 prices.
alter table public.picks alter column multiplier type numeric(6,3);
