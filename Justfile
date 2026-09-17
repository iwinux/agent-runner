fetch:
    @scripts/fetch-pi-packages.sh

sync:
    @rsync -avhz --delete-delay pi/fetched/extensions/ ~/.pi/agent/extensions/
