class EndpointInteraction:
    def run(self):
        host = self.config.get('host')
        endpoint = self.config.get('endpoint')
        method = self.config.get('method', 'GET')
        expected_status_code = self.config.get('expected_status_code', 200)
        auth_config = self.config.get('auth_config', {})
        if host == 'idp' or host == 'history':
            pass
