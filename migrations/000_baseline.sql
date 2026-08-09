--
-- 000_baseline.sql — startschema voor een LEGE (dev-)database.
--
-- Schema-only snapshot van de dev-database zoals die er na migratie 024 uitzag,
-- gemaakt met:
--     pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL"
--
-- Waarom dit bestand bestaat: de migraties 001..024 bouwen voort op tabellen die
-- ooit met de hand zijn aangemaakt. Een lege database vullen met alleen
-- migrations/ werkt daarom niet — je hebt dit startpunt nodig.
--
-- Gebruik (zie DEV_SETUP.md):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/000_baseline.sql
--
-- Dit bestand is een VLOER, geen spiegel: hij blijft op het niveau van 024 staan.
-- Migratie 025 en hoger draai je er daarna gewoon overheen — de INSERT onderaan
-- vult schema_migrations met 003..024, zodat scripts/deploy.sh en jijzelf zien
-- wat er al in zit. Regenereren is dus niet nodig bij elke nieuwe migratie.
--
-- NOOIT op productie draaien. scripts/deploy.sh slaat dit bestand expliciet over
-- (zie NEVER_RUN daar); de productie-DB heeft deze tabellen allang.
--
-- Bevat geen data: alleen DDL, geen enkele rij uit de dev-database.
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deck_id uuid NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requester_id uuid NOT NULL,
    addressee_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contacts_no_self CHECK ((requester_id <> addressee_id)),
    CONSTRAINT contacts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text])))
);


--
-- Name: deck_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deck_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deck_id uuid NOT NULL,
    owner_id uuid,
    recipient_id uuid NOT NULL,
    kind text DEFAULT 'invited'::text NOT NULL,
    group_id uuid,
    inactive boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    accepted_at timestamp with time zone DEFAULT now(),
    can_edit boolean DEFAULT false NOT NULL,
    CONSTRAINT deck_shares_group_id CHECK (((kind = 'group'::text) = (group_id IS NOT NULL))),
    CONSTRAINT deck_shares_kind_check CHECK ((kind = ANY (ARRAY['invited'::text, 'subscribed'::text, 'group'::text]))),
    CONSTRAINT deck_shares_no_self CHECK ((owner_id <> recipient_id))
);


--
-- Name: deck_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deck_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    deck_id uuid NOT NULL,
    date date NOT NULL,
    cards_practiced integer DEFAULT 0 NOT NULL,
    cards_correct_first_try integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    core_cards_practiced integer NOT NULL,
    core_correct_first_try integer NOT NULL,
    avg_remote_score numeric(5,2),
    avg_stable_score numeric(5,2),
    avg_recent_score numeric(5,2),
    avg_core_remote_score numeric(5,2),
    avg_core_stable_score numeric(5,2),
    avg_core_recent_score numeric(5,2),
    total_cards integer,
    total_core_cards integer
);


--
-- Name: decks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.decks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    title text NOT NULL,
    description text,
    is_public boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    inactive boolean DEFAULT false NOT NULL,
    core_only boolean DEFAULT false NOT NULL
);


--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verification_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: exam_decks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_decks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exam_id uuid NOT NULL,
    deck_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: exams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid,
    group_id uuid,
    name text NOT NULL,
    exam_date timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exams_scope CHECK (((group_id IS NOT NULL) OR (owner_id IS NOT NULL)))
);


--
-- Name: group_decks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_decks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    deck_id uuid NOT NULL,
    added_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    can_add_decks boolean DEFAULT true NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT group_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'pending'::text])))
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid,
    name text NOT NULL,
    description text,
    join_code text NOT NULL,
    join_password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    require_approval boolean DEFAULT false NOT NULL
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    product_key text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    canceled_at timestamp with time zone,
    source text DEFAULT 'manual'::text NOT NULL,
    external_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_period_valid CHECK (((expires_at IS NULL) OR (expires_at > started_at))),
    CONSTRAINT subscriptions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'stripe'::text, 'app_store'::text, 'play_store'::text])))
);


--
-- Name: user_card_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_card_progress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    card_id uuid NOT NULL,
    due_date timestamp with time zone,
    repetitions text DEFAULT ''::text NOT NULL,
    is_core boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    remote_score smallint NOT NULL,
    stable_score smallint NOT NULL,
    recent_score smallint DEFAULT 0 NOT NULL,
    longest_in_streak_hours integer
);


--
-- Name: user_daily_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_daily_snapshot (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    date date NOT NULL,
    total_cards integer DEFAULT 0 NOT NULL,
    cards_practiced_today integer DEFAULT 0 NOT NULL,
    correct_first_try_today integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    core_practiced_today integer DEFAULT 0 NOT NULL,
    core_correct_first_try_today integer DEFAULT 0 NOT NULL,
    total_core_cards integer NOT NULL,
    avg_remote_score numeric(5,2),
    avg_stable_score numeric(5,2),
    avg_recent_score numeric(5,2),
    avg_core_remote_score numeric(5,2),
    avg_core_stable_score numeric(5,2),
    avg_core_recent_score numeric(5,2)
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text,
    email_verified boolean DEFAULT true NOT NULL,
    tokens_valid_after timestamp with time zone DEFAULT to_timestamp((0)::double precision) NOT NULL,
    deletion_requested_at timestamp with time zone
);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: cards cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT cards_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: deck_shares deck_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_shares
    ADD CONSTRAINT deck_shares_pkey PRIMARY KEY (id);


--
-- Name: deck_stats deck_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_stats
    ADD CONSTRAINT deck_stats_pkey PRIMARY KEY (id);


--
-- Name: deck_stats deck_stats_user_id_deck_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_stats
    ADD CONSTRAINT deck_stats_user_id_deck_id_date_key UNIQUE (user_id, deck_id, date);


--
-- Name: decks decks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decks
    ADD CONSTRAINT decks_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_token_key UNIQUE (token);


--
-- Name: exam_decks exam_decks_exam_id_deck_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_decks
    ADD CONSTRAINT exam_decks_exam_id_deck_id_key UNIQUE (exam_id, deck_id);


--
-- Name: exam_decks exam_decks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_decks
    ADD CONSTRAINT exam_decks_pkey PRIMARY KEY (id);


--
-- Name: exams exams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_pkey PRIMARY KEY (id);


--
-- Name: group_decks group_decks_group_id_deck_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_decks
    ADD CONSTRAINT group_decks_group_id_deck_id_key UNIQUE (group_id, deck_id);


--
-- Name: group_decks group_decks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_decks
    ADD CONSTRAINT group_decks_pkey PRIMARY KEY (id);


--
-- Name: group_members group_members_group_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_user_id_key UNIQUE (group_id, user_id);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);


--
-- Name: groups groups_join_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_join_code_key UNIQUE (join_code);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_key UNIQUE (token);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: user_card_progress user_card_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_card_progress
    ADD CONSTRAINT user_card_progress_pkey PRIMARY KEY (id);


--
-- Name: user_card_progress user_card_progress_user_id_card_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_card_progress
    ADD CONSTRAINT user_card_progress_user_id_card_id_key UNIQUE (user_id, card_id);


--
-- Name: user_daily_snapshot user_daily_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_daily_snapshot
    ADD CONSTRAINT user_daily_snapshot_pkey PRIMARY KEY (id);


--
-- Name: user_daily_snapshot user_daily_snapshot_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_daily_snapshot
    ADD CONSTRAINT user_daily_snapshot_user_id_date_key UNIQUE (user_id, date);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: contacts_addressee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_addressee_idx ON public.contacts USING btree (addressee_id);


--
-- Name: contacts_pair_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_pair_uniq ON public.contacts USING btree (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));


--
-- Name: contacts_requester_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_requester_idx ON public.contacts USING btree (requester_id);


--
-- Name: deck_shares_direct_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deck_shares_direct_uniq ON public.deck_shares USING btree (deck_id, recipient_id) WHERE (group_id IS NULL);


--
-- Name: deck_shares_group_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deck_shares_group_uniq ON public.deck_shares USING btree (deck_id, recipient_id, group_id) WHERE (group_id IS NOT NULL);


--
-- Name: exam_decks_deck_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exam_decks_deck_idx ON public.exam_decks USING btree (deck_id);


--
-- Name: exams_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exams_group_idx ON public.exams USING btree (group_id);


--
-- Name: exams_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exams_owner_idx ON public.exams USING btree (owner_id);


--
-- Name: group_decks_deck_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_decks_deck_idx ON public.group_decks USING btree (deck_id);


--
-- Name: group_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_members_user_idx ON public.group_members USING btree (user_id);


--
-- Name: idx_cards_deck_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_deck_id ON public.cards USING btree (deck_id);


--
-- Name: idx_cards_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_deleted_at ON public.cards USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_cards_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_updated_at ON public.cards USING btree (deck_id, updated_at);


--
-- Name: idx_deck_shares_deck; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deck_shares_deck ON public.deck_shares USING btree (deck_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_deck_shares_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deck_shares_recipient ON public.deck_shares USING btree (recipient_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_deck_shares_recipient_revoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deck_shares_recipient_revoked ON public.deck_shares USING btree (recipient_id, revoked_at) WHERE (revoked_at IS NOT NULL);


--
-- Name: idx_deck_shares_recipient_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deck_shares_recipient_updated ON public.deck_shares USING btree (recipient_id, updated_at);


--
-- Name: idx_deck_stats_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deck_stats_updated_at ON public.deck_stats USING btree (user_id, updated_at);


--
-- Name: idx_decks_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_decks_deleted_at ON public.decks USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_decks_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_decks_public ON public.decks USING btree (created_at DESC) WHERE ((is_public = true) AND (deleted_at IS NULL));


--
-- Name: idx_decks_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_decks_updated_at ON public.decks USING btree (user_id, updated_at);


--
-- Name: idx_decks_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_decks_user_id ON public.decks USING btree (user_id);


--
-- Name: idx_email_verification_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_verification_tokens_token ON public.email_verification_tokens USING btree (token);


--
-- Name: idx_password_reset_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_tokens_user_id ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_progress_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_progress_updated_at ON public.user_card_progress USING btree (user_id, updated_at);


--
-- Name: idx_progress_user_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_progress_user_card ON public.user_card_progress USING btree (user_id, card_id);


--
-- Name: idx_user_card_progress_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_card_progress_deleted_at ON public.user_card_progress USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_user_daily_snapshot_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_daily_snapshot_updated_at ON public.user_daily_snapshot USING btree (user_id, updated_at);


--
-- Name: idx_user_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_due_date ON public.user_card_progress USING btree (user_id, due_date);


--
-- Name: subscriptions_external_ref_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_external_ref_uniq ON public.subscriptions USING btree (source, external_ref) WHERE (external_ref IS NOT NULL);


--
-- Name: subscriptions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_user_idx ON public.subscriptions USING btree (user_id);


--
-- Name: cards cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cards_updated_at BEFORE UPDATE ON public.cards FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deck_shares deck_shares_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deck_shares_updated_at BEFORE UPDATE ON public.deck_shares FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deck_stats deck_stats_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deck_stats_updated_at BEFORE UPDATE ON public.deck_stats FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: decks decks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER decks_updated_at BEFORE UPDATE ON public.decks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: exams exams_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER exams_updated_at BEFORE UPDATE ON public.exams FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: group_members group_members_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_members_updated_at BEFORE UPDATE ON public.group_members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: groups groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_card_progress progress_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER progress_updated_at BEFORE UPDATE ON public.user_card_progress FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subscriptions subscriptions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_daily_snapshot user_daily_snapshot_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_daily_snapshot_updated_at BEFORE UPDATE ON public.user_daily_snapshot FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cards cards_deck_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT cards_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_addressee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_addressee_id_fkey FOREIGN KEY (addressee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deck_shares deck_shares_deck_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_shares
    ADD CONSTRAINT deck_shares_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id);


--
-- Name: deck_shares deck_shares_group_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_shares
    ADD CONSTRAINT deck_shares_group_fk FOREIGN KEY (group_id) REFERENCES public.groups(id);


--
-- Name: deck_shares deck_shares_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_shares
    ADD CONSTRAINT deck_shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: deck_shares deck_shares_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_shares
    ADD CONSTRAINT deck_shares_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id);


--
-- Name: deck_stats deck_stats_deck_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_stats
    ADD CONSTRAINT deck_stats_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id) ON DELETE CASCADE;


--
-- Name: deck_stats deck_stats_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deck_stats
    ADD CONSTRAINT deck_stats_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: decks decks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decks
    ADD CONSTRAINT decks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: exam_decks exam_decks_deck_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_decks
    ADD CONSTRAINT exam_decks_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id) ON DELETE CASCADE;


--
-- Name: exam_decks exam_decks_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_decks
    ADD CONSTRAINT exam_decks_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.exams(id) ON DELETE CASCADE;


--
-- Name: exams exams_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: exams exams_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_decks group_decks_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_decks
    ADD CONSTRAINT group_decks_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_decks group_decks_deck_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_decks
    ADD CONSTRAINT group_decks_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES public.decks(id);


--
-- Name: group_decks group_decks_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_decks
    ADD CONSTRAINT group_decks_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: groups groups_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_card_progress user_card_progress_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_card_progress
    ADD CONSTRAINT user_card_progress_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE CASCADE;


--
-- Name: user_card_progress user_card_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_card_progress
    ADD CONSTRAINT user_card_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_daily_snapshot user_daily_snapshot_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_daily_snapshot
    ADD CONSTRAINT user_daily_snapshot_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



--
-- Configuratierij die migratie 006 aanmaakt. Een --schema-only dump bevat geen
-- rijen, en zonder deze rij leest de versiegate 0 en faalt test/client-version:
-- die doet een UPDATE, en dat raakt niets als de rij ontbreekt. '0' = poort open,
-- de juiste waarde voor een dev-database (productie staat hoger).
--

INSERT INTO public.app_config (key, value)
VALUES ('min_client_build', '0')
ON CONFLICT (key) DO NOTHING;


--
-- Migratiestand van deze baseline: dezelfde 22 rijen als productie.
-- 001 en 002 zijn ouder dan de tracking en staan bewust NIET in de tabel.
--

INSERT INTO public.schema_migrations (version) VALUES
    ('003_rename_ltm_remote_stm_stable_add_recent'),
    ('004_rename_remote_core_type_columns'),
    ('005_drop_legacy_ltm_stm'),
    ('006_app_config_min_client_build'),
    ('007_add_core_avg_scores'),
    ('008_cleanup_orphan_progress'),
    ('009_stats_updated_at_watermark'),
    ('010_tombstone_purge_indexes'),
    ('011_decks_inactive'),
    ('012_deck_stats_totals'),
    ('013_password_reset_and_token_revocation'),
    ('014_decks_core_only'),
    ('015_contacts'),
    ('016_deck_sharing'),
    ('017_groups'),
    ('018_share_accept'),
    ('019_deck_share_edit'),
    ('020_orphan_decks'),
    ('021_due_date_timestamptz'),
    ('022_subscriptions'),
    ('023_group_join_approval'),
    ('024_exams')

-- Idempotent: opnieuw draaien op een gevulde tabel doet niets.
ON CONFLICT (version) DO NOTHING;
