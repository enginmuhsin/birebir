#!/bin/sh
# Yerel test PostgreSQL'ini başlatır (yoksa kurar). Yalnız test ortamı içindir.
D=/var/lib/postgresql/bltest
[ -d $D/data ] || { mkdir -p $D && chown -R postgres:postgres $D && su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $D/data -A trust >/dev/null"; }
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $D/data status >/dev/null" || su postgres -c "rm -f $D/data/postmaster.pid; /usr/lib/postgresql/16/bin/pg_ctl -D $D/data -o '-p 54329 -k $D' -l $D/log -w start >/dev/null"
psql -h $D -p 54329 -U postgres -Atc "select 'pg hazır'"
