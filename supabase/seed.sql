-- local demo seed file. only runs locally
-- password for all demo users is "complyete-demo"
do $$
declare u record; uid uuid;
begin
  for u in select * from (values
    ('thadd.demo@complyete.test', 'Thadd (demo)'),
    ('marija.demo@complyete.test', 'Marija (demo)'),
    ('cyndi.demo@complyete.test', 'Cyndi (demo)')
  ) as t(email, name)
  loop
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', u.email,
      extensions.crypt('complyete-demo', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text,
      jsonb_build_object('sub', uid::text, 'email', u.email, 'email_verified', true),
      'email', now(), now(), now());
    insert into public.staff (auth_user_id, display_name, email, is_active)
    values (uid, u.name, u.email, true);
  end loop;
end $$;