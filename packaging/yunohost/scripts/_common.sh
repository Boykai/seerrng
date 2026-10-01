#!/bin/bash

#=================================================
# COMMON VARIABLES AND CUSTOM HELPERS
#=================================================

#=================================================
# PERSONAL HELPERS
#=================================================

seerrng_seed_settings() {
	local settings_file="$data_dir/settings.json"

	if [[ -L "$settings_file" ]]; then
		ynh_die --message="Refusing to initialize SeerrNG settings through a symlink."
	fi

	if [[ -e "$settings_file" ]]; then
		if [[ ! -f "$settings_file" ]]; then
			ynh_die --message="SeerrNG settings path exists but is not a regular file."
		fi
		return
	fi

	install -o "$app" -g "$app" -m 0600 /dev/null "$settings_file"
	printf '%s\n' '{"network":{"trustProxy":true}}' > "$settings_file"
	chown "$app:$app" "$settings_file"
	chmod 0600 "$settings_file"
}

seerrng_prepare_service() {
	local database_directory="$data_dir/db"
	local log_directory="$data_dir/logs"
	local log_file="$log_directory/seerr.log"

	for directory in "$database_directory" "$log_directory"; do
		if [[ -L "$directory" ]]; then
			ynh_die --message="Refusing to use a symlink as a SeerrNG data directory."
		fi
		if [[ -e "$directory" && ! -d "$directory" ]]; then
			ynh_die --message="SeerrNG data path exists but is not a directory."
		fi
	done
	install -d -o "$app" -g "$app" -m 0700 "$database_directory" "$log_directory"
	if [[ -L "$log_file" || ( -e "$log_file" && ! -f "$log_file" ) ]]; then
		ynh_die --message="SeerrNG log path is not a regular file."
	fi
	if [[ ! -f "$log_file" ]]; then
		install -o "$app" -g "$app" -m 0600 /dev/null "$log_file"
	fi
	chown "$app:$app" "$log_file"
	ynh_config_add_nginx
	ynh_config_add_systemd
}

seerrng_register_service() {
	local log_file="$data_dir/logs/seerr.log"

	if [[ ! -f "$log_file" ]]; then
		ynh_die --message="SeerrNG did not create its application log during startup."
	fi
	yunohost service add "$app" \
		--description="SeerrNG media request service" \
		--log="$log_file"
}
